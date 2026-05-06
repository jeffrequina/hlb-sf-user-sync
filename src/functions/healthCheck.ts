import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";

/**
 * HTTP Trigger: healthCheck
 *
 * Simple liveness probe — returns 200 with service metadata.
 *
 * Endpoint:  GET /api/health
 * Auth:      anonymous (no function key required)
 */
async function healthCheckHandler(
  _request: HttpRequest,
  _context: InvocationContext
): Promise<HttpResponseInit> {
  return {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      status: "healthy",
      service: "hlb-sf-user-sync",
      timestamp: new Date().toISOString(),
    }),
  };
}

app.http("healthCheck", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "health",
  handler: healthCheckHandler,
});
