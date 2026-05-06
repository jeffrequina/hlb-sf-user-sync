import axios, { AxiosInstance } from "axios";
import { config } from "../config/env";
import {
  HivebriteCreateUser,
  HivebriteUpdateUser,
  HivebriteUserResponse,
  HivebriteUsersListResponse,
} from "../models/hivebrite-user.model";
import { hivebriteAuthService } from "./hivebrite-auth.service";
import { HivebriteError } from "../utils/errors";
import logger from "../utils/logger";

/**
 * Token-bucket style rate limiter for the Hivebrite Admin API.
 *
 * Hivebrite enforces a hard limit of 300 requests per minute.
 * This limiter caps outgoing calls at MAX_RPM (290) to leave a safety
 * margin of 10 requests.  When the bucket is exhausted it calculates the
 * remaining milliseconds in the current 60-second window and sleeps until
 * the window resets before allowing further calls.
 */
class HivebriteRateLimiter {
  private static readonly MAX_RPM = 280;
  private count = 0;
  private windowStart = Date.now();

  async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.windowStart;

    // Reset the window if a full minute has already passed.
    if (elapsed >= 60_000) {
      this.count = 0;
      this.windowStart = now;
    }

    if (this.count >= HivebriteRateLimiter.MAX_RPM) {
      // Sleep for the remainder of the current window plus a small buffer.
      const waitMs = 60_000 - (Date.now() - this.windowStart) + 250;
      logger.warn("Hivebrite rate limiter: bucket exhausted — waiting for next window", {
        waitMs,
        requestsInWindow: this.count,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      this.count = 0;
      this.windowStart = Date.now();
    }

    this.count++;
  }

  /** Called when a 429 is received to hard-reset and wait out the minute. */
  async backOffAfter429(): Promise<void> {
    const waitMs = 60_000 - (Date.now() - this.windowStart) + 500;
    logger.warn("Hivebrite 429 received — backing off until next window", { waitMs });
    await new Promise<void>((resolve) => setTimeout(resolve, Math.max(waitMs, 1_000)));
    this.count = 0;
    this.windowStart = Date.now();
  }
}

/**
 * Hivebrite Admin API service.
 *
 * Authenticates via OAuth2 (password grant) using HivebriteAuthService.
 * The Bearer token is injected dynamically on each request via a request
 * interceptor, and automatically refreshed on 401 responses.
 *
 * All outgoing requests are transparently rate-limited to 290 req/min via
 * HivebriteRateLimiter to stay under Hivebrite's 300 req/min hard cap.
 *
 * Docs: https://developer.hivebrite.com/reference
 */
export class HivebriteService {
  private readonly client: AxiosInstance;
  private readonly rateLimiter = new HivebriteRateLimiter();
  /** Tracks in-flight 401 retry to avoid infinite loops */
  private isRefreshing = false;

  constructor() {
    this.client = axios.create({
      baseURL: config.hivebrite.apiBaseUrl,
      timeout: config.hivebrite.timeoutMs,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });

    // ── Request interceptor: rate-limit + inject current Bearer token ────
    this.client.interceptors.request.use(async (req) => {
      // Throttle every outgoing request to stay under 290 req/min.
      await this.rateLimiter.throttle();

      const token = await hivebriteAuthService.getAccessToken();
      req.headers["Authorization"] = `Bearer ${token}`;
      logger.debug("Hivebrite API request", {
        method: req.method?.toUpperCase(),
        url: req.url,
      });
      return req;
    });

    // ── Response interceptor: log + handle 401 refresh + 429 back-off ────
    this.client.interceptors.response.use(
      (res) => {
        logger.debug("Hivebrite API response", {
          status: res.status,
          url: res.config.url,
        });
        return res;
      },
      async (err) => {
        const originalRequest = err.config;

        if (!axios.isAxiosError(err)) {
          return Promise.reject(err);
        }

        const status = err.response?.status;

        // ── 429: rate limited — back off for the rest of the minute then retry once.
        if (status === 429 && !originalRequest._retried429) {
          originalRequest._retried429 = true;
          await this.rateLimiter.backOffAfter429();
          logger.warn("Hivebrite 429 — retrying after back-off", { url: originalRequest.url });
          return this.client(originalRequest);
        }

        // ── 401: token expired — refresh once and retry.
        if (
          status === 401 &&
          !this.isRefreshing &&
          !originalRequest._retry
        ) {
          this.isRefreshing = true;
          originalRequest._retry = true;

          try {
            logger.warn("Hivebrite 401 — refreshing token and retrying");
            const freshToken = await hivebriteAuthService.forceRefresh();
            originalRequest.headers["Authorization"] = `Bearer ${freshToken}`;
            return this.client(originalRequest);
          } finally {
            this.isRefreshing = false;
          }
        }

        // 404s are expected "not found" signals on lookup endpoints (e.g.
        // /users/find, /users/{id}).  Log at debug so individual callers can
        // decide whether a missing record is an error or normal flow.
        if (status === 404) {
          logger.debug("Hivebrite resource not found", {
            url: err.config?.url,
            data: err.response?.data,
          });
        } else {
          logger.error("Hivebrite API error", {
            status,
            url: err.config?.url,
            data: err.response?.data,
          });
        }
        return Promise.reject(err);
      }
    );
  }

  // ── Users: List ───────────────────────────────────────────────────────────
  /**
   * Fetch a paginated list of Hivebrite users.
   *
   * @param page          - Page number (1-based)
   * @param perPage       - Results per page (max 100)
   * @param updatedSince  - ISO 8601 date string to filter by last update
   */
  async getUsers(
    page = 1,
    perPage = 10,
    updatedSince?: string
  ): Promise<HivebriteUsersListResponse> {
    try {
      const params: Record<string, string | number> = { page, per_page: perPage };
      if (updatedSince) params["updated_since"] = updatedSince;

      const response = await this.client.get<HivebriteUsersListResponse>("/users", {
        params,
      });

      logger.info("Hivebrite users fetched", {
        page,
        perPage,
        returned: response.data.users?.length ?? 0,
        totalCount: response.data.total_count,
      });

      return response.data;
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        throw new HivebriteError(
          `Failed to fetch users from Hivebrite: ${err.message}`,
          err.response?.status ?? 502,
          err.response?.data
        );
      }
      throw err;
    }
  }

  // ── Users: Recently Updated (paginated) ──────────────────────────────────

  /**
   * Fetch ALL Hivebrite users whose `updated_since` falls within the given
   * ISO 8601 timestamp, then client-side filters to only those where
   * `extended_updated_at` also falls within that window.
   *
   * Automatically pages through every result page (max 100 per page) and
   * returns a single flat array.
   *
   * @param updatedSince - ISO 8601 string, e.g. "2026-03-23T10:00:00.000Z"
   */
  async getRecentlyUpdatedUsers(
    updatedSince: string
  ): Promise<HivebriteUserResponse[]> {
    const perPage = 100; // Hivebrite hard maximum is 100 per page
    const allUsers: HivebriteUserResponse[] = [];
    let page = 1;

    try {
      while (true) {
        const response = await this.client.get<HivebriteUsersListResponse>(
          "/users",
          { params: { page, per_page: perPage, updated_since: updatedSince } }
        );

        const { users, total_count } = response.data;
        if (!users || users.length === 0) break;

        allUsers.push(...users);

        logger.info("Hivebrite recently-updated users page fetched", {
          page,
          returned: users.length,
          totalSoFar: allUsers.length,
          total_count,
        });

        // Break when the page is not full — this is the last page.
        // We cannot rely on `allUsers.length >= total_count` because Hivebrite
        // returns the total count of ALL users in the system, not just the
        // filtered (updated_since) subset. Requesting a page beyond what the
        // filter produces results in 404 "expected :page in 1..N; got N+1".
        if (users.length < perPage) break;
        page++;
      }

      // Client-side filter: only keep users whose extended_updated_at is
      // within the moving window (handles APIs that ignore updated_since or
      // use a different timestamp field internally).
      const windowStart = new Date(updatedSince).getTime();
      const filtered = allUsers.filter((u) => {
        const ts = u.extended_updated_at ?? u.updated_at;
        return ts ? new Date(ts).getTime() >= windowStart : false;
      });

      logger.info("Hivebrite recently-updated users resolved", {
        updatedSince,
        totalFetched: allUsers.length,
        afterWindowFilter: filtered.length,
      });

      return filtered;
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        throw new HivebriteError(
          `Failed to fetch recently-updated users from Hivebrite: ${err.message}`,
          err.response?.status ?? 502,
          err.response?.data
        );
      }
      throw err;
    }
  }

  // ── Users: Get by ID ─────────────────────────────────────────────────────
  /**
   * Fetch the full profile of a single Hivebrite user by their numeric ID.
   * GET /api/admin/v1/users/{id}
   *
   * The list endpoint (GET /users) only returns summary fields. Fields such as
   * summary, linkedin_profile_url, and custom_attributes are only present on
   * the single-user response — this method must be used before mapping a
   * Hivebrite user back to Salesforce.
   *
   * Response is wrapped: { "user": { ... } }
   */
  async getUserById(hivebriteUserId: number): Promise<HivebriteUserResponse | null> {
    try {
      const response = await this.client.get<{ user: HivebriteUserResponse }>(
        `/users/${hivebriteUserId}`
      );
      return response.data?.user ?? null;
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        return null;
      }
      throw new HivebriteError(
        `Failed to fetch Hivebrite user by ID ${hivebriteUserId}: ${err instanceof Error ? err.message : String(err)}`,
        502,
        err
      );
    }
  }

  // ── Users: Find ───────────────────────────────────────────────────────────
  /**
   * Look up a user by email address (list-search fallback).
   * Returns null if the user does not exist (404 or empty result).
   */
  async findUserByEmail(email: string): Promise<HivebriteUserResponse | null> {
    try {
      const response = await this.client.get<HivebriteUsersListResponse>("/users", {
        params: { q: email, per_page: 1 },
      });

      const users = response.data?.users ?? [];
      return users.find((u) => u.email.toLowerCase() === email.toLowerCase()) ?? null;
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        return null;
      }
      throw new HivebriteError("Failed to look up user in Hivebrite", 502, err);
    }
  }

  /**
   * Exact email lookup via POST /api/admin/v1/users/find.
   *
   * Uses multipart form data as required by the Hivebrite API:
   *   field=email
   *   value=<email address>
   *
   * The endpoint wraps the result in a `user` key:
   *   { "user": { "id": 123, "email": "...", ... } }
   *
   * Returns the matched user or null (404 / no match).
   */
  async findUserByEmailPost(email: string): Promise<HivebriteUserResponse | null | undefined> {
    const formData = new FormData();
    formData.append("field", "email");
    formData.append("value", email);

    try {
      const response = await this.client.post<{ user: HivebriteUserResponse }>(
        "/users/find",
        formData
      );

      // logger.info("_______Hivebrite USER BY EMAIL", {
      //   response: JSON.stringify(response.data?.user?.updated_at ?? "no updated_at"),
      //   updated_at: response.data?.user?.updated_at,
      //   time_now: new Date(Date.now()).toISOString(),
      //   time_diff: new Date(new Date(Date.now()).getTime() - new Date(response.data?.user?.updated_at ?? "").getTime()).toISOString(),
      // });

      // Skip users not updated within the last 15 minutes
      if (response.data?.user?.updated_at && Date.now() - new Date(response.data.user.updated_at).getTime() < 15 * 60 * 1000) {
        // logger.info("_______Hivebrite USER JUST RECENTLY UPDATED... SKIPPING");
        return undefined;
      }
        
      return response.data?.user ?? null;
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        return null;
      }
      throw new HivebriteError(
        `Failed to find Hivebrite user by email (POST): ${email}`,
        502,
        err
      );
    }
  }

  // ── Users: Create ─────────────────────────────────────────────────────────
  /**
   * Create a new Hivebrite user.
   * POST /api/admin/v1/users
   *
   * Hivebrite expects the body wrapped: { "user": { ... } }
   * and responds with the same wrapper: { "user": { "id": ..., ... } }
   */
  async createUser(payload: HivebriteCreateUser): Promise<HivebriteUserResponse> {
    try {
      const response = await this.client.post<{ user: HivebriteUserResponse }>(
        "/users",
        { user: payload }
      );
      const user = response.data.user;
      logger.info("Hivebrite user created", {
        email: payload.email,
        hivebriteId: user.id,
      });
      return user;
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        throw new HivebriteError(
          `Failed to create Hivebrite user: ${err.message}`,
          err.response?.status ?? 502,
          err.response?.data
        );
      }
      throw err;
    }
  }

  // ── Users: Update ─────────────────────────────────────────────────────────
  /**
   * Update an existing Hivebrite user by their numeric ID.
   * PUT /api/admin/v1/users/{id}
   *
   * Hivebrite expects the body wrapped: { "user": { ... } }
   * and responds with the same wrapper: { "user": { "id": ..., ... } }
   */
  async updateUser(
    hivebriteUserId: number,
    payload: HivebriteUpdateUser
  ): Promise<HivebriteUserResponse> {
    try {
      const response = await this.client.put<{ user: HivebriteUserResponse }>(
        `/users/${hivebriteUserId}`,
        { user: payload }
      );
      const user = response.data.user;
      logger.info("Hivebrite user updated", {
        email: payload.email,
        hivebriteId: hivebriteUserId,
      });
      return user;
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        throw new HivebriteError(
          `Failed to update Hivebrite user: ${err.message}`,
          err.response?.status ?? 502,
          err.response?.data
        );
      }
      throw err;
    }
  }

  // ── Users: Upsert ─────────────────────────────────────────────────────────
  /**
   * Upsert a user: create if not found by email, update if already exists.
   * This is the primary method used by the Salesforce sync function.
   */
  async upsertUser(payload: HivebriteCreateUser): Promise<{
    action: "created" | "updated";
    user: HivebriteUserResponse;
  }> {
    const existing = await this.findUserByEmail(payload.email);

    if (existing) {
      const user = await this.updateUser(existing.id, payload as HivebriteUpdateUser);
      return { action: "updated", user };
    }

    const user = await this.createUser(payload);
    return { action: "created", user };
  }
}

// Singleton
export const hivebriteService = new HivebriteService();
