import axios from "axios";
import { URLSearchParams } from "url";
import { config } from "../config/env";
import logger from "../utils/logger";
import { AppError } from "../utils/errors";

interface TokenResponse {
  access_token: string;
  token_type: string;
  instance_url: string;
  /** Seconds until expiry. Salesforce Client Credentials tokens are typically 1 hour. */
  expires_in?: number;
  scope?: string;
}

interface CachedToken {
  accessToken: string;
  instanceUrl: string;
  expiresAt: number; // Unix ms timestamp
}

/**
 * Salesforce OAuth2 Client Credentials service.
 *
 * Returns a cached token when one exists and is still valid; otherwise
 * calls the Salesforce OAuth endpoint to obtain a fresh token first,
 * then attaches it to any subsequent API calls.
 *
 * Grant type: client_credentials
 * Credentials sent in: request body (not Basic auth header)
 */
export class SalesforceAuthService {
  private cache: CachedToken | null = null;

  /** Refresh 1 minute before actual expiry to avoid edge-case 401s */
  private readonly expiryBufferMs = 60_000;

  /**
   * Returns a valid Bearer access token:
   *  - If a cached token exists and has not expired → reuse it.
   *  - Otherwise → call the OAuth endpoint for a fresh token first,
   *    cache it, then return it.
   */
  async getAccessToken(): Promise<{ accessToken: string; instanceUrl: string }> {
    if (this.cache && Date.now() < this.cache.expiresAt) {
      logger.debug("Using cached Salesforce access token", {
        expiresIn: Math.round((this.cache.expiresAt - Date.now()) / 1000) + "s",
      });
      return {
        accessToken: this.cache.accessToken,
        instanceUrl: this.cache.instanceUrl,
      };
    }

    logger.info("Cached token missing or expired — fetching fresh Salesforce OAuth2 token");
    return this.fetchToken();
  }

  /**
   * Force-bypass the cache and fetch a new token.
   * Called automatically when the Salesforce API returns a 401.
   */
  async refreshToken(): Promise<{ accessToken: string; instanceUrl: string }> {
    logger.info("Force-refreshing Salesforce OAuth2 access token");
    this.cache = null;
    return this.fetchToken();
  }

  private async fetchToken(): Promise<{ accessToken: string; instanceUrl: string }> {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.salesforce.clientId,
      client_secret: config.salesforce.clientSecret,
    });

    try {
      const response = await axios.post<TokenResponse>(
        config.salesforce.oauthTokenUrl,
        body.toString(),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          timeout: config.salesforce.timeoutMs,
        }
      );

      const { access_token, instance_url, expires_in } = response.data;

      const ttlMs = (expires_in ?? 3600) * 1000 - this.expiryBufferMs;
      this.cache = {
        accessToken: access_token,
        instanceUrl: instance_url,
        expiresAt: Date.now() + ttlMs,
      };

      logger.info("Salesforce access token acquired and cached", {
        instanceUrl: instance_url,
        expiresInSec: expires_in ?? 3600,
      });

      return { accessToken: access_token, instanceUrl: instance_url };
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status ?? 0;
        const detail = err.response?.data;
        logger.error("Salesforce OAuth2 token request failed", { status, detail });
        throw new AppError(
          `Salesforce OAuth2 error: ${detail?.error_description ?? err.message}`,
          502,
          detail
        );
      }
      throw err;
    }
  }
}

// Singleton — shared across warm function invocations to reuse cached tokens
export const salesforceAuthService = new SalesforceAuthService();
