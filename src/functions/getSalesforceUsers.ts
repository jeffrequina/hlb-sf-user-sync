import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { salesforceUsersService } from "../services/salesforce-users.service";
import { normaliseError } from "../utils/errors";
import logger from "../utils/logger";

/**
 * HTTP Trigger: getSalesforceUsers
 *
 * Authenticates to Salesforce via OAuth2 Client Credentials, then queries
 * Salesforce User data and returns it as JSON.
 *
 * Endpoint:  GET /api/salesforce/users
 *
 * Optional Query Params:
 *   q  - Custom URL-encoded SOQL query string.
 *        Defaults to: SELECT Id,Name,Email,Username,IsActive FROM User
 *
 * Example:
 *   GET /api/salesforce/users
 *   GET /api/salesforce/users?q=SELECT+Id,Name,Email+FROM+User+WHERE+IsActive=true
 *
 * Auth: Azure Function key (append ?code=<key> or pass x-functions-key header)
 *
 * Success Response 200:
 * {
 *   "success": true,
 *   "totalSize": 42,
 *   "done": true,
 *   "records": [ { "Id": "...", "Name": "...", "Email": "...", ... } ]
 * }
 */
async function getSalesforceUsersHandler(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  const correlationId =
    request.headers.get("x-correlation-id") ?? context.invocationId;

  const requestLogger = logger.child({ correlationId });

  requestLogger.info("getSalesforceUsers invoked", {
    method: request.method,
    url: request.url,
  });

  try {
    // Allow caller to pass a custom SOQL query via ?q= parameter
    const customQuery = request.query.get("q") ?? undefined;

    const result = await salesforceUsersService.getUsers(customQuery);

    return jsonResponse(200, {
      success: true,
      totalSize: result.totalSize,
      done: result.done,
      ...(result.nextRecordsUrl
        ? { nextRecordsUrl: result.nextRecordsUrl }
        : {}),
      records: result.records,
      correlationId,
    });
  } catch (err: unknown) {
    const { statusCode, message, details } = normaliseError(err);

    requestLogger.error("getSalesforceUsers failed", {
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

function jsonResponse(status: number, body: unknown): HttpResponseInit {
  return {
    status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

app.http("getSalesforceUsers", {
  methods: ["GET"],
  authLevel: "function",
  route: "salesforce/users",
  handler: getSalesforceUsersHandler,
});
