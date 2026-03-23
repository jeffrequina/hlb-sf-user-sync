import axios from "axios";
import { URLSearchParams } from "url";
import { config } from "../config/env";
import logger from "../utils/logger";
import { AppError } from "../utils/errors";

interface HivebriteTokenResponse {
  access_token: string;
  token_type: string;
  /** Seconds until expiry */
  expires_in: number;
  /** Present when scope includes offline_access; use to re-authenticate silently */
  refresh_token?: string;
  scope?: string;
  created_at?: number;
}

interface CachedToken {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number; // Unix ms timestamp
}

/**
 * Hivebrite OAuth2 token service.
 *
 * Hivebrite uses the Resource Owner Password Credentials grant (password grant).
 * Credentials are sent in the POST body as x-www-form-urlencoded — NOT in
 * Authorization headers.
 *
 * Token endpoint: POST https://hlb.hivebrite.com/api/oauth/token
 * Body fields:
 *   grant_type    = password
 *   scope         = admin
 *   admin_email   = <admin email>
 *   password      = <admin password>
 *   client_id     = <client id>
 *   client_secret = <client secret>
 *
 * The token is cached in memory for the lifetime of the Azure Function warm
 * instance. When it approaches expiry the service will silently refresh using
 * the refresh_token (if provided), or fall back to a full re-authentication.
 */
export class HivebriteAuthService {
  private cache: CachedToken | null = null;

  /** Refresh 2 minutes before actual expiry to avoid edge-case 401s */
  private readonly expiryBufferMs = 120_000;

  /**
   * Returns a valid Bearer access token, refreshing transparently if needed.
   */
  async getAccessToken(): Promise<string> {
    if (this.cache && Date.now() < this.cache.expiresAt) {
      logger.debug("Using cached Hivebrite access token", {
        expiresIn: Math.round((this.cache.expiresAt - Date.now()) / 1000) + "s",
      });
      return this.cache.accessToken;
    }

    // Try refresh token first if we have one, then fall back to full password grant
    if (this.cache?.refreshToken) {
      try {
        return await this.fetchWithRefreshToken(this.cache.refreshToken);
      } catch {
        logger.warn("Hivebrite refresh token failed — falling back to password grant");
        this.cache = null;
      }
    }

    return this.fetchWithPasswordGrant();
  }

  /**
   * Force-clear the cache and re-authenticate.
   * Called automatically when the API returns a 401.
   */
  async forceRefresh(): Promise<string> {
    logger.info("Force-refreshing Hivebrite access token");
    this.cache = null;
    return this.fetchWithPasswordGrant();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async fetchWithPasswordGrant(): Promise<string> {
    logger.info("Fetching Hivebrite access token via password grant");

    const body = new URLSearchParams({
      grant_type: "password",
      scope: "admin",
      admin_email: config.hivebrite.adminEmail,
      password: config.hivebrite.adminPassword,
      client_id: config.hivebrite.clientId,
      client_secret: config.hivebrite.clientSecret,
    });

    return this.postToken(body);
  }

  private async fetchWithRefreshToken(refreshToken: string): Promise<string> {
    logger.info("Refreshing Hivebrite access token via refresh_token");

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.hivebrite.clientId,
      client_secret: config.hivebrite.clientSecret,
    });

    return this.postToken(body);
  }

  private async postToken(body: URLSearchParams): Promise<string> {
    try {
      const response = await axios.post<HivebriteTokenResponse>(
        config.hivebrite.oauthTokenUrl,
        body.toString(),
        {
          headers: {
            // Hivebrite OAuth endpoint expects form-encoded body, no Authorization header
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          timeout: config.hivebrite.timeoutMs,
        }
      );

      const { access_token, refresh_token, expires_in } = response.data;
      const ttlMs = (expires_in ?? 7200) * 1000 - this.expiryBufferMs;

      this.cache = {
        accessToken: access_token,
        refreshToken: refresh_token ?? null,
        expiresAt: Date.now() + ttlMs,
      };

      logger.info("Hivebrite access token acquired", {
        hasRefreshToken: !!refresh_token,
        expiresInSec: expires_in,
      });

      return access_token;
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status ?? 0;
        const detail = err.response?.data;
        logger.error("Hivebrite OAuth2 token request failed", { status, detail });
        throw new AppError(
          `Hivebrite OAuth2 error: ${detail?.error_description ?? detail?.error ?? err.message}`,
          502,
          detail
        );
      }
      throw err;
    }
  }
}

// Singleton — shared across warm function invocations to reuse cached tokens
export const hivebriteAuthService = new HivebriteAuthService();
