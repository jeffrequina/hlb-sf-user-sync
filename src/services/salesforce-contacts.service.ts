import axios, { AxiosInstance } from "axios";
import { config } from "../config/env";
import { salesforceAuthService } from "./salesforce-auth.service";
import {
  SalesforceQueryResponse,
  SalesforceContactRecord,
  SalesforceContactUpdatePayload,
} from "../models/salesforce-query.model";
import { AppError } from "../utils/errors";
import logger from "../utils/logger";

/**
 * Default SOQL query for Salesforce Contacts.
 * Selects only the fields needed for Hivebrite synchronisation.
 */
const DEFAULT_CONTACT_QUERY =
  "SELECT Id, LastName, FirstName, Name, Email, Description, " +
  "CurrencyIsoCode, OwnerId, CreatedDate, CreatedById, LastModifiedDate, " +
  "LastModifiedById, SystemModstamp, LastActivityDate, LastCURequestDate, " +
  "LastCUUpdateDate, LastViewedDate, LastReferencedDate, LinkedInUrl__c, " +
  "Member_Firm_Role__c, Azure_AD_Sync__c, AzureADUserID__c, " +
  "Hivebrite_Status__c, Contact_Groups__c, Contact_Industries__c, " +
  "Contact_Languages__c, Contact_Skills__c, Hivebrite_User_Id__c " +
  "FROM Contact";

/**
 * Salesforce Contacts service.
 *
 * Queries the Salesforce REST API using a Bearer token obtained from
 * SalesforceAuthService. Handles 401 token expiry by refreshing once and
 * retrying automatically — same pattern as SalesforceUsersService.
 */
export class SalesforceContactsService {
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
   * Fetch all contacts (or a custom SOQL query) from Salesforce.
   *
   * Always acquires a fresh OAuth token before the API call.
   *
   * @param soqlQuery - Plain SOQL string (defaults to the contact sync query)
   * @param retry     - Internal flag: false on the retry attempt to avoid infinite loops
   */
  async getContacts(
    soqlQuery = DEFAULT_CONTACT_QUERY,
    retry = true
  ): Promise<SalesforceQueryResponse<SalesforceContactRecord>> {
    const { accessToken, instanceUrl } =
      await salesforceAuthService.getAccessToken();

    const client = this.buildClient(instanceUrl, accessToken);

    try {
      logger.info("Querying Salesforce contacts", { soqlQuery });

      const response = await client.get<
        SalesforceQueryResponse<SalesforceContactRecord>
      >("/query", {
        params: { q: soqlQuery },
      });

      logger.info("Salesforce contacts fetched", {
        totalSize: response.data.totalSize,
        returned: response.data.records.length,
        done: response.data.done,
      });

      return response.data;
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        if (err.response?.status === 401 && retry) {
          logger.warn(
            "Salesforce token expired mid-request — refreshing and retrying"
          );
          await salesforceAuthService.refreshToken();
          return this.getContacts(soqlQuery, false);
        }

        const status = err.response?.status ?? 502;
        const detail = err.response?.data;
        logger.error("Salesforce API contacts query failed", {
          status,
          detail,
        });

        throw new AppError(
          `Salesforce API error: ${err.message}`,
          status >= 500 ? 502 : status,
          detail
        );
      }
      throw err;
    }
  }
  /**
   * Look up a single Salesforce Contact by email address.
   *
   * Returns the first matching record or null when no contact has that email.
   * Uses the same minimal field set needed for a subsequent updateContact call.
   *
   * @param email - The email address to search for
   * @param retry - Internal 401-retry guard
   */
  async getContactByEmail(
    email: string,
    retry = true
  ): Promise<SalesforceContactRecord | null> {
    const { accessToken, instanceUrl } =
      await salesforceAuthService.getAccessToken();

    const client = this.buildClient(instanceUrl, accessToken);

    // Escape single quotes to prevent SOQL injection
    const safeEmail = email.replace(/'/g, "\\'");
    const soqlQuery =
      "SELECT Id, LastName, FirstName, Name, Email, Description, " +
      "LinkedInUrl__c, Contact_Groups__c, Contact_Industries__c, " +
      "Contact_Languages__c, Contact_Skills__c, Hivebrite_User_Id__c " +
      `FROM Contact WHERE Email = '${safeEmail}'`;

    try {
      logger.info("Looking up Salesforce contact by email", { email });

      const response = await client.get<
        SalesforceQueryResponse<SalesforceContactRecord>
      >("/query", { params: { q: soqlQuery } });

      const record = response.data.records[0] ?? null;

      logger.info("Salesforce contact lookup result", {
        email,
        found: record !== null,
        salesforceId: record?.Id,
      });

      return record;
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        if (err.response?.status === 401 && retry) {
          logger.warn("Salesforce token expired — refreshing and retrying");
          await salesforceAuthService.refreshToken();
          return this.getContactByEmail(email, false);
        }

        const status = err.response?.status ?? 502;
        const detail = err.response?.data;
        logger.error("Salesforce contact lookup failed", { status, detail });

        throw new AppError(
          `Salesforce API error: ${err.message}`,
          status >= 500 ? 502 : status,
          detail
        );
      }
      throw err;
    }
  }

  /**
   * Partially update an existing Salesforce Contact.
   *
   * Uses PATCH /services/data/v{version}/sobjects/Contact/{Id} which only
   * overwrites the fields present in the payload — all other fields are left
   * unchanged. Salesforce returns 204 No Content on success.
   *
   * @param contactId - The Salesforce Contact 18-char ID
   * @param payload   - Fields to overwrite (only the fields provided are changed)
   * @param retry     - Internal 401-retry guard
   */
  async updateContact(
    contactId: string,
    payload: SalesforceContactUpdatePayload,
    retry = true
  ): Promise<void> {
    const { accessToken, instanceUrl } =
      await salesforceAuthService.getAccessToken();

    const client = this.buildClient(instanceUrl, accessToken);

    try {
      logger.info("Updating Salesforce contact", { contactId, payload });

      await client.patch(`/sobjects/Contact/${contactId}`, payload, {
        headers: { "Content-Type": "application/json" },
      });

      logger.info("Salesforce contact updated", { contactId });
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        if (err.response?.status === 401 && retry) {
          logger.warn("Salesforce token expired — refreshing and retrying");
          await salesforceAuthService.refreshToken();
          return this.updateContact(contactId, payload, false);
        }

        const status = err.response?.status ?? 502;
        const detail = err.response?.data;
        logger.error("Salesforce contact update failed", {
          contactId,
          status,
          detail,
        });

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
export const salesforceContactsService = new SalesforceContactsService();
