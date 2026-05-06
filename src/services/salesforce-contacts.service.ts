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
   * Client whose baseURL is just the Salesforce instance root.
   * Used for pagination — nextRecordsUrl is already an absolute path
   * (e.g. /services/data/v60.0/query/01g...) so it must not be prefixed
   * with the versioned path that buildClient() uses.
   */
  private buildRootClient(instanceUrl: string, accessToken: string): AxiosInstance {
    return axios.create({
      baseURL: instanceUrl,
      timeout: config.salesforce.timeoutMs,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
  }

  /**
   * Fetch ALL contacts from Salesforce, following pagination automatically.
   *
   * Salesforce caps each query page at 2,000 records and sets done=false with
   * a nextRecordsUrl when more pages exist. This method keeps fetching until
   * done=true, then returns a single merged response containing every record.
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

    const client     = this.buildClient(instanceUrl, accessToken);
    const rootClient = this.buildRootClient(instanceUrl, accessToken);

    try {
      logger.info("Querying Salesforce contacts", { soqlQuery });

      const firstPage = await client.get<
        SalesforceQueryResponse<SalesforceContactRecord>
      >("/query", { params: { q: soqlQuery } });

      const allRecords: SalesforceContactRecord[] = [...firstPage.data.records];
      let done           = firstPage.data.done;
      let nextRecordsUrl = firstPage.data.nextRecordsUrl;

      logger.info("Salesforce contacts page 1 fetched", {
        totalSize:   firstPage.data.totalSize,
        pageRecords: firstPage.data.records.length,
        done,
      });

      while (!done && nextRecordsUrl) {
        logger.info("Fetching next page of Salesforce contacts", {
          nextRecordsUrl,
          fetchedSoFar: allRecords.length,
        });

        const page = await rootClient.get<
          SalesforceQueryResponse<SalesforceContactRecord>
        >(nextRecordsUrl);

        allRecords.push(...page.data.records);
        done           = page.data.done;
        nextRecordsUrl = page.data.nextRecordsUrl;

        logger.info("Salesforce contacts page fetched", {
          pageRecords:  page.data.records.length,
          totalFetched: allRecords.length,
          done,
        });
      }

      logger.info("Salesforce contacts fully fetched", {
        totalSize:    firstPage.data.totalSize,
        totalFetched: allRecords.length,
      });

      return {
        totalSize:    firstPage.data.totalSize,
        done:         true,
        records:      allRecords,
      };
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
   * Fetch only Salesforce contacts modified on or after `updatedSince`.
   *
   * Appends a `WHERE LastModifiedDate >= {updatedSince}` clause to the
   * default contact query, so only contacts changed within the current sync
   * window are returned.  Used by Phase 1 (SF → HB) to mirror the time-window
   * filtering that Phase 2 already applies when reading Hivebrite.
   *
   * @param updatedSince - ISO 8601 string, e.g. "2026-03-23T10:00:00.000Z"
   */
  async getRecentlyModifiedContacts(
    updatedSince: string
  ): Promise<SalesforceQueryResponse<SalesforceContactRecord>> {
    const filteredQuery =
      DEFAULT_CONTACT_QUERY +
      ` WHERE LastModifiedDate >= ${updatedSince}` +
      " ORDER BY LastModifiedDate ASC";
    return this.getContacts(filteredQuery);
  }

  /**
   * Fetch only Salesforce contacts whose CreatedDate falls on or after `createdSince`.
   *
   * Used by the createHivebriteUsers timer to limit the provisioning scan to
   * contacts created within the current time window, avoiding a full-table scan
   * on every run.
   *
   * @param createdSince - ISO 8601 string, e.g. "2026-04-01T09:00:00.000Z"
   */
  async getRecentlyCreatedContacts(
    createdSince: string
  ): Promise<SalesforceQueryResponse<SalesforceContactRecord>> {
    const filteredQuery =
      DEFAULT_CONTACT_QUERY +
      ` WHERE CreatedDate >= ${createdSince}` +
      " ORDER BY CreatedDate ASC";
    return this.getContacts(filteredQuery);
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
