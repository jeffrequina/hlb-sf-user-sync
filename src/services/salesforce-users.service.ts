import axios, { AxiosInstance } from "axios";
import { config } from "../config/env";
import { salesforceAuthService } from "./salesforce-auth.service";
import {
  SalesforceQueryResponse,
  SalesforceUserRecord,
} from "../models/salesforce-query.model";
import { AppError } from "../utils/errors";
import logger from "../utils/logger";

/** Default SOQL query used by getUsers(). Plain SQL — axios handles URL encoding. */
const DEFAULT_USER_QUERY =
  "SELECT Id, Name, Email, Username, IsActive FROM User";

/**
 * Salesforce Users service.
 *
 * Queries the Salesforce REST API using the Bearer token obtained from
 * SalesforceAuthService. Handles 401 token expiry by refreshing once and
 * retrying automatically.
 */
export class SalesforceUsersService {
  private buildClient(instanceUrl: string, accessToken: string): AxiosInstance {
    return axios.create({
      baseURL: `${instanceUrl}/services/data/${config.salesforce.apiVersion}`,
      timeout: config.salesforce.timeoutMs,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
  }

  /**
   * Fetch all users (or a custom SOQL query) from Salesforce.
   *
   * Always acquires a fresh OAuth token before the API call.
   *
   * @param soqlQuery - Plain SOQL string (defaults to Id, Name, Email, Username, IsActive)
   * @param retry     - Internal flag: set to false on the retry attempt to avoid infinite loops
   */
  async getUsers(
    soqlQuery = DEFAULT_USER_QUERY,
    retry = true
  ): Promise<SalesforceQueryResponse<SalesforceUserRecord>> {
    // Always fetch a fresh token before every Salesforce API call
    const { accessToken, instanceUrl } =
      await salesforceAuthService.getAccessToken();

    const client = this.buildClient(instanceUrl, accessToken);

    try {
      logger.info("Querying Salesforce users", { soqlQuery });

      // Pass the plain SOQL string directly — axios serialises it correctly
      const response = await client.get<
        SalesforceQueryResponse<SalesforceUserRecord>
      >(`/query`, {
        params: { q: soqlQuery },
      });

      logger.info("Salesforce users fetched", {
        totalSize: response.data.totalSize,
        returned: response.data.records.length,
        done: response.data.done,
      });

      return response.data;
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        // 401 → token may have been revoked mid-session; refresh once and retry
        if (err.response?.status === 401 && retry) {
          logger.warn("Salesforce token expired mid-request — refreshing and retrying");
          await salesforceAuthService.refreshToken();
          return this.getUsers(soqlQuery, false);
        }

        const status = err.response?.status ?? 502;
        const detail = err.response?.data;
        logger.error("Salesforce API query failed", { status, detail });

        throw new AppError(
          `Salesforce API error: ${err.message}`,
          status >= 500 ? 502 : status,
          detail
        );
      }
      throw err;
    }
  }
}

// Singleton
export const salesforceUsersService = new SalesforceUsersService();
