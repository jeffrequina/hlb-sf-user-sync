import axios, { AxiosInstance } from "axios";
import { config } from "../config/env";
import { HivebriteUserPayload, HivebriteUserResponse } from "../models/hivebrite-user.model";
import { HivebriteError } from "../utils/errors";
import logger from "../utils/logger";

/**
 * Hivebrite Admin API service.
 * Handles create and update of user accounts on the Hivebrite platform.
 *
 * Docs: https://developer.hivebrite.com/reference
 */
export class HivebriteService {
  private readonly client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: config.hivebrite.apiBaseUrl,
      timeout: config.hivebrite.timeoutMs,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        /**
         * Hivebrite uses Bearer token auth for the Admin API.
         * The token is a long-lived API key generated in the Hivebrite back-office.
         */
        Authorization: `Bearer ${config.hivebrite.apiToken}`,
      },
    });

    // Request interceptor for logging
    this.client.interceptors.request.use((req) => {
      logger.debug("Hivebrite API request", {
        method: req.method?.toUpperCase(),
        url: req.url,
      });
      return req;
    });

    // Response interceptor for logging
    this.client.interceptors.response.use(
      (res) => {
        logger.debug("Hivebrite API response", {
          status: res.status,
          url: res.config.url,
        });
        return res;
      },
      (err) => {
        logger.error("Hivebrite API error", {
          status: err.response?.status,
          url: err.config?.url,
          data: err.response?.data,
        });
        return Promise.reject(err);
      }
    );
  }

  /**
   * Look up a user by email address.
   * Returns null if the user does not exist (404).
   */
  async findUserByEmail(email: string): Promise<HivebriteUserResponse | null> {
    try {
      const response = await this.client.get<{ users: HivebriteUserResponse[] }>(
        "/users",
        { params: { q: email, per_page: 1 } }
      );

      const users = response.data?.users ?? [];
      const match = users.find(
        (u) => u.email.toLowerCase() === email.toLowerCase()
      );
      return match ?? null;
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        return null;
      }
      throw new HivebriteError(
        "Failed to look up user in Hivebrite",
        502,
        err
      );
    }
  }

  /**
   * Create a new user on Hivebrite.
   */
  async createUser(
    payload: HivebriteUserPayload
  ): Promise<HivebriteUserResponse> {
    try {
      const response = await this.client.post<HivebriteUserResponse>(
        "/users",
        payload
      );
      logger.info("Hivebrite user created", {
        email: payload.user.email,
        hivebriteId: response.data.id,
      });
      return response.data;
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        throw new HivebriteError(
          `Failed to create user in Hivebrite: ${err.message}`,
          err.response?.status ?? 502,
          err.response?.data
        );
      }
      throw err;
    }
  }

  /**
   * Update an existing user on Hivebrite by their numeric Hivebrite ID.
   */
  async updateUser(
    hivebriteUserId: number,
    payload: HivebriteUserPayload
  ): Promise<HivebriteUserResponse> {
    try {
      const response = await this.client.put<HivebriteUserResponse>(
        `/users/${hivebriteUserId}`,
        payload
      );
      logger.info("Hivebrite user updated", {
        email: payload.user.email,
        hivebriteId: hivebriteUserId,
      });
      return response.data;
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        throw new HivebriteError(
          `Failed to update user in Hivebrite: ${err.message}`,
          err.response?.status ?? 502,
          err.response?.data
        );
      }
      throw err;
    }
  }

  /**
   * Upsert a user: create if not found, update if already exists.
   * This is the primary method called by the sync function.
   */
  async upsertUser(payload: HivebriteUserPayload): Promise<{
    action: "created" | "updated";
    user: HivebriteUserResponse;
  }> {
    const existing = await this.findUserByEmail(payload.user.email);

    if (existing) {
      const user = await this.updateUser(existing.id, payload);
      return { action: "updated", user };
    }

    const user = await this.createUser(payload);
    return { action: "created", user };
  }
}
