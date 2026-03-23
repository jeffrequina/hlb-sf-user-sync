import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { hivebriteService } from "../services/hivebrite.service";
import { normaliseError } from "../utils/errors";
import logger from "../utils/logger";

/**
 * HTTP Trigger: getHivebriteUsers
 *
 * Authenticates to Hivebrite via OAuth2 (password grant), then fetches
 * paginated user data from the Hivebrite Admin API.
 *
 * Endpoint:  GET /api/hivebrite/users
 *
 * Query Parameters:
 *   page           - Page number, 1-based (default: 1)
 *   per_page       - Results per page (default: 10, max: 100)
 *   updated_since  - ISO 8601 date string to filter by last update
 *                    e.g. 2017-08-01T00:00:00
 *
 * Examples:
 *   GET /api/hivebrite/users
 *   GET /api/hivebrite/users?page=2&per_page=50
 *   GET /api/hivebrite/users?updated_since=2024-01-01T00:00:00
 *
 * Auth: Azure Function key (append ?code=<key> or pass x-functions-key header)
 *
 * Success Response 200:
 * {
 *   "success": true,
 *   "page": 1,
 *   "per_page": 10,
 *   "total_count": 200,
 *   "users": [ { "id": 1, "email": "...", "firstname": "...", ... } ]
 * }
 */
async function getHivebriteUsersHandler(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  const correlationId =
    request.headers.get("x-correlation-id") ?? context.invocationId;

  const requestLogger = logger.child({ correlationId });

  requestLogger.info("getHivebriteUsers invoked", {
    method: request.method,
    url: request.url,
  });

  try {
    const page = parseInt(request.query.get("page") ?? "1", 10);
    const perPage = parseInt(request.query.get("per_page") ?? "10", 10);
    const updatedSince = request.query.get("updated_since") ?? undefined;

    if (isNaN(page) || page < 1) {
      return jsonResponse(400, {
        success: false,
        error: "Invalid 'page' parameter — must be a positive integer",
        correlationId,
      });
    }

    if (isNaN(perPage) || perPage < 1 || perPage > 100) {
      return jsonResponse(400, {
        success: false,
        error: "Invalid 'per_page' parameter — must be between 1 and 100",
        correlationId,
      });
    }

    const result = await hivebriteService.getUsers(page, perPage, updatedSince);

    return jsonResponse(200, {
      success: true,
      page: result.page ?? page,
      per_page: result.per_page ?? perPage,
      total_count: result.total_count,
      users: result.users,
      correlationId,
    });
  } catch (err: unknown) {
      const { statusCode, message, details } = normaliseError(err);

      requestLogger.error("getHivebriteUsers failed", {
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

app.http("getHivebriteUsers", {
  methods: ["GET"],
  authLevel: "function",
  route: "hivebrite/users",
  handler: getHivebriteUsersHandler,
});
