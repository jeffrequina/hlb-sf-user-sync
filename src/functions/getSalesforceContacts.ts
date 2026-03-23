import { app, InvocationContext, Timer } from "@azure/functions";
import { salesforceContactsService } from "../services/salesforce-contacts.service";
import { hivebriteService } from "../services/hivebrite.service";
import { SalesforceContactRecord } from "../models/salesforce-query.model";
import {
  HivebriteCreateUser,
  HivebriteCustomAttribute,
  HivebriteUserResponse,
} from "../models/hivebrite-user.model";
import { SalesforceContactUpdatePayload } from "../models/salesforce-query.model";
import logger from "../utils/logger";

/**
 * Polling interval expressed as a 6-field Azure Functions CRON expression.
 *
 * Format: {seconds} {minutes} {hours} {day} {month} {day-of-week}
 *
 * Change this constant to adjust how frequently the sync runs.
 *
 * TEMP (local testing): every 30 seconds.
 * Swap back to the 15-minute production schedule after confirming wiring works.
 */
const POLL_SCHEDULE = "0 */15 * * * *";
// const POLL_SCHEDULE = "*/30 * * * * *";

/**
 * The size of the HB→SF reverse-sync moving window in milliseconds.
 * Only Hivebrite users whose extended_updated_at falls within
 * [now - REVERSE_SYNC_WINDOW_MS, now] will be written back to Salesforce.
 *
 * Default: 15 minutes (matches the production poll interval).
 */
const REVERSE_SYNC_WINDOW_MS = 15 * 60 * 1000;

// ── Shared custom-attribute name constants ────────────────────────────────────

const ATTR_SKILL = "_0a86d02f_Skill";
const ATTR_INDUSTRIES = "_a3d06190_Industries";
const ATTR_LANGUAGE = "_ced3eaa1_Language";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Split a nullable comma-separated Salesforce field into a trimmed string array.
 */
function parseCommaList(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Joins an array of strings into a single comma-separated string.
 * Returns undefined when the array is empty so the field is omitted from the
 * Salesforce PATCH body rather than written as an empty string.
 */
function joinCommaList(values: string[]): string | undefined {
  return values.length > 0 ? values.join(", ") : undefined;
}

/**
 * Find a custom attribute by name and return its values array.
 */
function getAttrValues(
  attrs: HivebriteCustomAttribute[] | undefined,
  name: string
): string[] {
  return attrs?.find((a) => a.name === name)?.value ?? [];
}

// ── Phase 1: Salesforce → Hivebrite mapper ────────────────────────────────────

/**
 * Map a Salesforce Contact record to a Hivebrite create/update payload.
 *
 *   SF LastName              → HB lastname
 *   SF FirstName             → HB firstname
 *   SF Email                 → HB email + sso_identifier
 *   SF Description           → HB summary
 *   SF LinkedInUrl__c        → HB linkedin_profile_url
 *   SF Contact_Groups__c  \
 *   SF Contact_Skills__c  /  → HB custom_attributes[_0a86d02f_Skill]  (merged)
 *   SF Contact_Industries__c → HB custom_attributes[_a3d06190_Industries]
 *   SF Contact_Languages__c  → HB custom_attributes[_ced3eaa1_Language]
 */
function mapContactToHivebrite(
  contact: SalesforceContactRecord
): HivebriteCreateUser {
  const skillValues = [
    ...parseCommaList(contact.Contact_Groups__c),
    ...parseCommaList(contact.Contact_Skills__c),
  ];

  const customAttributes: HivebriteCustomAttribute[] = [];

  if (skillValues.length > 0) {
    customAttributes.push({ name: ATTR_SKILL, value: skillValues });
  }

  const industryValues = parseCommaList(contact.Contact_Industries__c);
  if (industryValues.length > 0) {
    customAttributes.push({ name: ATTR_INDUSTRIES, value: industryValues });
  }

  const languageValues = parseCommaList(contact.Contact_Languages__c);
  if (languageValues.length > 0) {
    customAttributes.push({ name: ATTR_LANGUAGE, value: languageValues });
  }

  return {
    id: 0,
    email: contact.Email!,
    firstname: contact.FirstName ?? "",
    lastname: contact.LastName,
    is_active: true,
    summary: contact.Description ?? undefined,
    linkedin_profile_url: contact.LinkedInUrl__c ?? undefined,
    sso_identifier: contact.Email!,
    ...(customAttributes.length > 0 ? { custom_attributes: customAttributes } : {}),
    locale: "en",
  };
}

// ── Phase 2: Hivebrite → Salesforce mapper ────────────────────────────────────

/**
 * Map a Hivebrite user response to a Salesforce Contact PATCH payload.
 *
 *   HB firstname               → SF FirstName
 *   HB lastname                → SF LastName
 *   HB summary                 → SF Description
 *   HB linkedin_profile_url    → SF LinkedInUrl__c
 *   HB custom_attrs[_Skill]    → SF Contact_Groups__c  (comma-joined)
 *   HB custom_attrs[_Skill]    → SF Contact_Skills__c  (same source, comma-joined)
 *   HB custom_attrs[Industries]→ SF Contact_Industries__c
 *   HB custom_attrs[Language]  → SF Contact_Languages__c
 */
function mapHivebriteToSalesforceContact(
  hbUser: HivebriteUserResponse
): SalesforceContactUpdatePayload {
  const attrs = hbUser.custom_attributes;

  const skillStr = joinCommaList(getAttrValues(attrs, ATTR_SKILL));
  const industriesStr = joinCommaList(getAttrValues(attrs, ATTR_INDUSTRIES));
  const languagesStr = joinCommaList(getAttrValues(attrs, ATTR_LANGUAGE));

  const payload: SalesforceContactUpdatePayload = {};

  if (hbUser.firstname) payload.FirstName = hbUser.firstname;
  if (hbUser.lastname)  payload.LastName  = hbUser.lastname;
  if (hbUser.summary)   payload.Description = hbUser.summary;
  if (hbUser.linkedin_profile_url) payload.LinkedInUrl__c = hbUser.linkedin_profile_url;
  if (skillStr)         payload.Contact_Groups__c = skillStr;
  if (skillStr)         payload.Contact_Skills__c  = skillStr;
  if (industriesStr)    payload.Contact_Industries__c = industriesStr;
  if (languagesStr)     payload.Contact_Languages__c  = languagesStr;

  return payload;
}

// ── Phase 1 ───────────────────────────────────────────────────────────────────

/**
 * Sync all Salesforce contacts → Hivebrite (create or update).
 */
async function syncSalesforceToHivebrite(
  runLogger: ReturnType<typeof logger.child>
): Promise<void> {
  runLogger.info("Phase 1 start: Salesforce → Hivebrite");

  const { records, totalSize } = await salesforceContactsService.getContacts();

  runLogger.info("Salesforce contacts retrieved", { totalSize });

  if (totalSize === 0) {
    runLogger.info("Phase 1: no contacts — skipping");
    return;
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const contact of records) {
    if (!contact.Email || !contact.AzureADUserID__c) {
      runLogger.warn("Phase 1: skipping contact — missing email or AzureADUserID__c", {
        salesforceId: contact.Id,
        name: contact.Name,
        hasEmail: !!contact.Email,
        hasAzureADUserId: !!contact.AzureADUserID__c,
      });
      skipped++;
      continue;
    }

    // TEMP TESTING: only sync ssmith@eidebailly.com
    if (contact.Email !== "ssmith@eidebailly.com") {
      runLogger.warn("Phase 1: skipping contact — NOT ssmith@eidebailly.com (TEMP TESTING)", {
        salesforceId: contact.Id,
        name: contact.Name,
        email: contact.Email,
      });
      skipped++;
      continue;
    }

    const cLog = runLogger.child({ salesforceId: contact.Id, email: contact.Email });

    try {
      // console.log("______contact.Email", contact.Email);
      const existingUser = await hivebriteService.findUserByEmailPost(contact.Email);
      const payload = mapContactToHivebrite(contact);

      if (existingUser) {
        // console.log("______existingUser UPDATED");
        await hivebriteService.updateUser(existingUser.id, payload);
        cLog.info("Phase 1: Hivebrite user updated", { hivebriteId: existingUser.id });
        updated++;
      } else {
        // console.log("______User CREATED");
        const newUser = await hivebriteService.createUser(payload);
        cLog.info("Phase 1: Hivebrite user created", { hivebriteId: newUser.id });
        created++;
      }
    } catch (err: unknown) {
      cLog.error("Phase 1: failed to sync contact to Hivebrite", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  runLogger.info("Phase 1 complete: Salesforce → Hivebrite", {
    total: totalSize,
    created,
    updated,
    skipped,
    errors: totalSize - created - updated - skipped,
  });
}

// ── Phase 2 ───────────────────────────────────────────────────────────────────

/**
 * Sync recently-updated Hivebrite users → Salesforce contacts (update only).
 *
 * Moving window: [now - REVERSE_SYNC_WINDOW_MS, now].
 * Only contacts that already exist in Salesforce are updated — no creates.
 */
async function syncHivebriteToSalesforce(
  runLogger: ReturnType<typeof logger.child>
): Promise<void> {
  const updatedSince = new Date(Date.now() - REVERSE_SYNC_WINDOW_MS).toISOString();

  runLogger.info("Phase 2 start: Hivebrite → Salesforce", { updatedSince });

  const recentUsers = await hivebriteService.getRecentlyUpdatedUsers(updatedSince);

  runLogger.info("Hivebrite recently-updated users retrieved", {
    count: recentUsers.length,
    updatedSince,
  });

  if (recentUsers.length === 0) {
    runLogger.info("Phase 2: no recently-updated Hivebrite users — skipping");
    return;
  }

  let updated = 0;
  let skipped = 0;

  for (const hbUser of recentUsers) {
    if (!hbUser.email) {
      runLogger.warn("Phase 2: skipping Hivebrite user — no email", {
        hivebriteId: hbUser.id,
      });
      skipped++;
      continue;
    }

    // TEMP TESTING: only sync ssmith@eidebailly.com
    if (hbUser.email !== "ssmith@eidebailly.com") {
      runLogger.warn("Phase 2: skipping Hivebrite user — NOT ssmith@eidebailly.com (TEMP TESTING)", {
        hivebriteId: hbUser.id,
        email: hbUser.email,
      });
      skipped++;
      continue;
    }

    const uLog = runLogger.child({ hivebriteId: hbUser.id, email: hbUser.email });

    try {
      // Find the matching Salesforce contact by email
      const sfContact = await salesforceContactsService.getContactByEmail(
        hbUser.email
      );

      if (!sfContact) {
        uLog.info("Phase 2: no matching Salesforce contact — skipping (update only)");
        skipped++;
        continue;
      }

      const updatePayload = mapHivebriteToSalesforceContact(hbUser);

      // TEMP TESTING: only sync ssmith@eidebailly.com
      if (hbUser.email === "ssmith@eidebailly.com") {
        console.log("______updatePayload", updatePayload);
        console.log("______sfContact", sfContact);
      }

      // Skip if there is nothing to patch (all mapped fields are empty)
      if (Object.keys(updatePayload).length === 0) {
        uLog.info("Phase 2: nothing to update in Salesforce");
        skipped++;
        continue;
      }

      await salesforceContactsService.updateContact(sfContact.Id, updatePayload);
      uLog.info("Phase 2: Salesforce contact updated", {
        salesforceId: sfContact.Id,
      });
      updated++;
    } catch (err: unknown) {
      uLog.error("Phase 2: failed to sync Hivebrite user to Salesforce", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  runLogger.info("Phase 2 complete: Hivebrite → Salesforce", {
    total: recentUsers.length,
    updated,
    skipped,
    errors: recentUsers.length - updated - skipped,
  });
}

// ── Timer handler ─────────────────────────────────────────────────────────────

/**
 * Timer Trigger: getSalesforceContacts
 *
 * Runs on POLL_SCHEDULE and executes two sequential sync phases:
 *
 *   Phase 1 — Salesforce → Hivebrite
 *     Fetches all SF contacts and creates/updates matching Hivebrite users.
 *
 *   Phase 2 — Hivebrite → Salesforce  (reverse sync)
 *     Fetches Hivebrite users updated within the last REVERSE_SYNC_WINDOW_MS,
 *     then PATCHes the corresponding Salesforce contacts with the latest values.
 *     Only updates existing contacts — never creates new ones in Salesforce.
 */
async function getSalesforceContactsHandler(
  myTimer: Timer,
  context: InvocationContext
): Promise<void> {
  const runLogger = logger.child({
    invocationId: context.invocationId,
    trigger: "timer",
  });

  runLogger.info("getSalesforceContacts timer triggered", {
    isPastDue: myTimer.isPastDue,
    schedule: POLL_SCHEDULE,
  });

  try {
    await syncSalesforceToHivebrite(runLogger);
    await syncHivebriteToSalesforce(runLogger);

    runLogger.info("getSalesforceContacts both sync phases complete");
  } catch (err: unknown) {
    runLogger.error("getSalesforceContacts fatal error", {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

// ── Registration ──────────────────────────────────────────────────────────────

app.timer("getSalesforceContacts", {
  schedule: POLL_SCHEDULE,
  handler: getSalesforceContactsHandler,
});
