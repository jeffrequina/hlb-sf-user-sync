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
 * Hivebrite Admin API service.
 *
 * Authenticates via OAuth2 (password grant) using HivebriteAuthService.
 * The Bearer token is injected dynamically on each request via a request
 * interceptor, and automatically refreshed on 401 responses.
 *
 * Docs: https://developer.hivebrite.com/reference
 */
export class HivebriteService {
  private readonly client: AxiosInstance;
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

    // ── Request interceptor: inject current Bearer token ──────────────────
    this.client.interceptors.request.use(async (req) => {
      const token = await hivebriteAuthService.getAccessToken();
      req.headers["Authorization"] = `Bearer ${token}`;
      logger.debug("Hivebrite API request", {
        method: req.method?.toUpperCase(),
        url: req.url,
      });
      return req;
    });

    // ── Response interceptor: log + handle 401 with one token refresh ─────
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

        if (
          axios.isAxiosError(err) &&
          err.response?.status === 401 &&
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

        logger.error("Hivebrite API error", {
          status: err.response?.status,
          url: err.config?.url,
          data: err.response?.data,
        });
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
    const perPage = 100;
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

        // Stop when we have retrieved all available records
        if (allUsers.length >= total_count) break;
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
   * Returns the matched user or null (404 / no match).
   */
  async findUserByEmailPost(email: string): Promise<HivebriteUserResponse | null> {
    const formData = new FormData();
    formData.append("field", "email");
    formData.append("value", email);

    try {
      const response = await this.client.post<HivebriteUserResponse>(
        "/users/find",
        formData
      );
      return response.data ?? null;
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
   */
  async createUser(payload: HivebriteCreateUser): Promise<HivebriteUserResponse> {
    try {
      const response = await this.client.post<HivebriteUserResponse>("/users", payload);
      logger.info("Hivebrite user created", {
        email: payload.email,
        hivebriteId: response.data.id,
      });
      return response.data;
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
   */
  async updateUser(
    hivebriteUserId: number,
    payload: HivebriteUpdateUser
  ): Promise<HivebriteUserResponse> {
    try {
      const response = await this.client.put<HivebriteUserResponse>(
        `/users/${hivebriteUserId}`,
        payload
      );
      logger.info("Hivebrite user updated", {
        email: payload.email,
        hivebriteId: hivebriteUserId,
      });
      return response.data;
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
