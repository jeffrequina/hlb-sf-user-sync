import { app, InvocationContext, Timer } from "@azure/functions";
import { salesforceContactsService } from "../services/salesforce-contacts.service";
import { hivebriteService } from "../services/hivebrite.service";
import { HivebriteCreateUser } from "../models/hivebrite-user.model";
import logger from "../utils/logger";
import { mapContactToHivebrite } from "./getSalesforceContacts";

/**
 * Timer schedule: every 10 minutes.
 * Format: {seconds} {minutes} {hours} {day} {month} {day-of-week}
 */
const CREATE_SCHEDULE = "0 */10 * * * *";
// const CREATE_SCHEDULE = "*/30 * * * * *";

/**
 * Only Salesforce contacts whose CreatedDate falls within the last
 * CREATION_WINDOW_MS milliseconds are scanned for Hivebrite provisioning.
 * Defaults to 60 minutes so each 15-minute run has a 4× safety overlap,
 * ensuring a contact created between cycles is never permanently missed.
 */
const CREATION_WINDOW_MS = 60 * 60 * 1000;

/** Default Hivebrite sub-network to assign on user creation. COMMUNITY MEMBERSHIP TYPE */
const DEFAULT_SUB_NETWORK_IDS = [129071];

/**
 * In-memory set of email addresses that were successfully provisioned in
 * Hivebrite during the current Azure Function instance lifetime.
 *
 * Module-level variables persist across timer invocations within the same
 * warm instance, so an email added here is skipped on every subsequent cycle
 * without making any Hivebrite API calls.  The set is cleared automatically
 * when the instance is recycled (cold start).
 */
const provisionedEmails = new Set<string>();

/**
 * Scan ALL Salesforce contacts and provision any that are missing from Hivebrite.
 *
 * This function does not care about CreatedDate or LastModifiedDate — it checks
 * every eligible contact (must have both Email and AzureADUserID__c) against
 * Hivebrite by email address. If the user does not exist in Hivebrite it is
 * created. If the user already exists the contact is skipped.
 *
 * Create-only: no updates are performed here. Field synchronisation for
 * existing users is handled by the main getSalesforceContacts timer.
 */
async function createHivebriteUsersHandler(
  myTimer: Timer,
  context: InvocationContext
): Promise<void> {
  const runLogger = logger.child({
    invocationId: context.invocationId,
    trigger: "createHivebriteUsers",
  });

  const createdSince = new Date(Date.now() - CREATION_WINDOW_MS).toISOString();

  runLogger.info("createHivebriteUsers timer triggered", {
    isPastDue: myTimer.isPastDue,
    schedule: CREATE_SCHEDULE,
    createdSince,
  });

  const { records, totalSize } =
    await salesforceContactsService.getRecentlyCreatedContacts(createdSince);

  runLogger.info("Salesforce contacts retrieved for Hivebrite provisioning", {
    totalSize,
    createdSince,
  });

  if (totalSize === 0) {
    runLogger.info("createHivebriteUsers: no recently-created contacts found — skipping");
    return;
  }

  let created = 0;
  let skipped = 0;
  let errors = 0;

  for (const contact of records) {
    // Both Email and AzureADUserID__c are required to provision a Hivebrite account.
    if (!contact.Email || !contact.AzureADUserID__c) {
      runLogger.warn("createHivebriteUsers: skipping contact — missing email or AzureADUserID__c", {
        salesforceId: contact.Id,
        name: contact.Name,
        hasEmail: !!contact.Email,
        hasAzureADUserId: !!contact.AzureADUserID__c,
      });
      skipped++;
      continue;
    }

    const cLog = runLogger.child({ salesforceId: contact.Id, email: contact.Email });

    // Fast-path: already provisioned in a previous cycle this instance lifetime.
    if (provisionedEmails.has(contact.Email)) {
      cLog.debug("createHivebriteUsers: email in provisioned cache — skipping");
      skipped++;
      continue;
    }

    try {
      // Use the POST exact-match lookup. This avoids the fuzzy GET search
      // which can miss existing users when per_page=1 returns a different record.
      // Returns: HivebriteUserResponse (found), undefined (found but recently
      // updated < 15 min), or null (not found / 404).
      // Both truthy and undefined mean the user EXISTS — skip and cache.
      const existingUser = await hivebriteService.findUserByEmailPost(contact.Email);

      if (existingUser !== null) {
        // User exists in Hivebrite (truthy = confirmed, undefined = just updated).
        provisionedEmails.add(contact.Email);
        cLog.debug("createHivebriteUsers: user already exists in Hivebrite — skipping");
        skipped++;
        continue;
      }

      // cLog.info("________createHivebriteUsers: creating new user", {
      //   salesforceId: contact.Id,
      //   email: contact.Email,
      //   createdSince,
      //   createdAt: contact.CreatedDate,
      //   azureADUserId: contact.AzureADUserID__c,
      // });

      const payload = mapContactToHivebrite(contact);
      const newUser = await hivebriteService.createUser({
        ...payload,
        email: contact.Email,
        sub_network_ids: DEFAULT_SUB_NETWORK_IDS,
      } as HivebriteCreateUser);

      provisionedEmails.add(contact.Email);

      cLog.info("createHivebriteUsers: Hivebrite user created", {
        hivebriteId: newUser.id,
        provisionedCacheSize: provisionedEmails.size,
      });
      created++;
    } catch (err: unknown) {
      // 422 "already been taken" means the user exists despite the lookup
      // returning null (race condition or index lag). Treat as provisioned.
      if (
        err instanceof Error &&
        err.message.toLowerCase().includes("already been taken")
      ) {
        provisionedEmails.add(contact.Email);
        cLog.warn("createHivebriteUsers: user already exists (422) — adding to cache", {
          error: err.message,
        });
        skipped++;
        continue;
      }

      cLog.error("createHivebriteUsers: failed to provision Hivebrite user", {
        error: err instanceof Error ? err.message : String(err),
      });
      errors++;
    }
  }

  runLogger.info("createHivebriteUsers complete", {
    total: totalSize,
    created,
    skipped,
    errors,
    provisionedCacheSize: provisionedEmails.size,
  });
}

// ── Registration ──────────────────────────────────────────────────────────────

app.timer("createHivebriteUsers", {
  schedule: CREATE_SCHEDULE,
  handler: createHivebriteUsersHandler,
});
