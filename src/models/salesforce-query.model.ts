/**
 * Salesforce REST API SOQL query response envelope.
 */
export interface SalesforceQueryResponse<T> {
  totalSize: number;
  done: boolean;
  /** URL for the next page of results (present when done is false) */
  nextRecordsUrl?: string;
  records: T[];
}

/**
 * Salesforce User record as returned by:
 * SELECT Id, Name, Email, Username, IsActive FROM User
 */
export interface SalesforceUserRecord {
  attributes: {
    type: string;
    url: string;
  };
  Id: string;
  Name: string;
  Email: string;
  Username: string;
  IsActive: boolean;
}

/**
 * Salesforce Contact record returned by the contacts SOQL query.
 * Fields sourced from: src/docs/salesforce-contacts-final-fields.json
 */
export interface SalesforceContactRecord {
  attributes: {
    type: string;
    url: string;
  };
  Id: string;
  LastName: string;
  FirstName: string | null;
  Name: string;
  Email: string | null;
  Description: string | null;
  CurrencyIsoCode: string;
  OwnerId: string;
  CreatedDate: string;
  CreatedById: string;
  LastModifiedDate: string;
  LastModifiedById: string;
  SystemModstamp: string;
  LastActivityDate: string | null;
  LastCURequestDate: string | null;
  LastCUUpdateDate: string | null;
  LastViewedDate: string | null;
  LastReferencedDate: string | null;
  LinkedInUrl__c: string | null;
  Member_Firm_Role__c: string | null;
  Azure_AD_Sync__c: boolean;
  AzureADUserID__c: string | null;
  Hivebrite_Status__c: string | null;
  /** Comma-separated group names */
  Contact_Groups__c: string | null;
  /** Comma-separated industry names */
  Contact_Industries__c: string | null;
  /** Comma-separated language names */
  Contact_Languages__c: string | null;
  /** Comma-separated skill names */
  Contact_Skills__c: string | null;
  /** Hivebrite numeric user ID stored back in Salesforce after first sync */
  Hivebrite_User_Id__c: string | null;
}

/**
 * Partial Salesforce Contact payload for PATCH /sobjects/Contact/{Id}.
 * Only the fields that the HB→SF reverse sync is allowed to overwrite.
 */
export interface SalesforceContactUpdatePayload {
  FirstName?: string;
  LastName?: string;
  Description?: string;
  LinkedInUrl__c?: string;
  /** Comma-separated skill values (from Hivebrite _0a86d02f_Skill attribute) */
  Contact_Groups__c?: string;
  /** Comma-separated skill values (same source as Contact_Groups__c) */
  Contact_Skills__c?: string;
  /** Comma-separated industry values */
  Contact_Industries__c?: string;
  /** Comma-separated language values */
  Contact_Languages__c?: string;
}
