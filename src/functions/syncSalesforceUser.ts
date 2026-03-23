import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { SalesforceWebhookPayloadSchema } from "../models/salesforce-user.model";
import { hivebriteService } from "../services/hivebrite.service";
import { mapSalesforceUserToHivebrite } from "../services/user-mapper.service";
import { validateSalesforceSignature } from "../middleware/auth.middleware";
import { normaliseError } from "../utils/errors";
import logger from "../utils/logger";

/**
 * HTTP Trigger: syncSalesforceUser
 *
 * Receives a Salesforce user created/updated event and syncs the user
 * to the Hivebrite community platform.
 *
 * Endpoint:  POST /api/sync/salesforce-user
 *
 * Expected Headers:
 *   Content-Type:     application/json
 *   X-SF-Signature:   sha256=<hmac-sha256-hex>   (HMAC of raw body using SF_WEBHOOK_SECRET)
 *
 * Expected Body:
 * {
 *   "user": {
 *     "Id": "005...",
 *     "Email": "user@example.com",
 *     "FirstName": "Jane",
 *     "LastName": "Doe",
 *     "IsActive": true,
 *     "EventType": "created" | "updated",
 *     ... (other SF User fields)
 *   }
 * }
 *
 * Success Response 200:
 * {
 *   "success": true,
 *   "action": "created" | "updated",
 *   "hivebriteUserId": 12345,
 *   "email": "user@example.com"
 * }
 */
async function syncSalesforceUserHandler(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  const correlationId =
    request.headers.get("x-correlation-id") ??
    context.invocationId;

  const requestLogger = logger.child({ correlationId });

  requestLogger.info("syncSalesforceUser invoked", {
    method: request.method,
    url: request.url,
  });

  try {
    // ── 1. Read raw body ──────────────────────────────────────────────────
    const rawBody = await request.text();

    if (!rawBody) {
      return jsonResponse(400, {
        success: false,
        error: "Request body is empty",
        correlationId,
      });
    }

    // ── 2. Verify HMAC signature ──────────────────────────────────────────
    await validateSalesforceSignature(request, rawBody);

    // ── 3. Parse & validate JSON payload ─────────────────────────────────
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      return jsonResponse(400, {
        success: false,
        error: "Request body is not valid JSON",
        correlationId,
      });
    }

    const parseResult = SalesforceWebhookPayloadSchema.safeParse(parsedBody);
    if (!parseResult.success) {
      requestLogger.warn("Payload validation failed", {
        errors: parseResult.error.flatten(),
      });
      return jsonResponse(400, {
        success: false,
        error: "Payload validation failed",
        details: parseResult.error.flatten().fieldErrors,
        correlationId,
      });
    }

    const { user: sfUser } = parseResult.data;

    requestLogger.info("Processing Salesforce user sync", {
      salesforceId: sfUser.Id,
      email: sfUser.Email,
      eventType: sfUser.EventType,
    });

    // ── 4. Map Salesforce → Hivebrite ─────────────────────────────────────
    const hivebritePayload = mapSalesforceUserToHivebrite(sfUser);

    // ── 5. Upsert user in Hivebrite ───────────────────────────────────────
    const { action, user: hivebriteUser } =
      await hivebriteService.upsertUser(hivebritePayload);

    requestLogger.info("User sync successful", {
      salesforceId: sfUser.Id,
      hivebriteUserId: hivebriteUser.id,
      action,
    });

    return jsonResponse(200, {
      success: true,
      action,
      hivebriteUserId: hivebriteUser.id,
      email: hivebriteUser.email,
      correlationId,
    });
  } catch (err: unknown) {
    const { statusCode, message, details } = normaliseError(err);

    requestLogger.error("syncSalesforceUser failed", {
      statusCode,
      message,
      details,
    });

    return jsonResponse(statusCode, {
      success: false,
      error: message,
      ...(details ? { details } : {}),
      correlationId,
    });
  }
}

/**
 * Health-check endpoint.
 * GET /api/health
 */
async function healthCheckHandler(
  _request: HttpRequest,
  _context: InvocationContext
): Promise<HttpResponseInit> {
  return jsonResponse(200, {
    status: "healthy",
    service: "hlb-sf-user-sync",
    timestamp: new Date().toISOString(),
  });
}

function jsonResponse(status: number, body: unknown): HttpResponseInit {
  return {
    status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

app.http("syncSalesforceUser", {
  methods: ["POST"],
  authLevel: "function",
  route: "sync/salesforce-user",
  handler: syncSalesforceUserHandler,
});

app.http("healthCheck", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "health",
  handler: healthCheckHandler,
});
