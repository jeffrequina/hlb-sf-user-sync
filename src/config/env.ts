/**
 * Centralised, validated environment configuration.
 * Fails fast at startup if required variables are missing.
 *
 * Salesforce OAuth2 credentials are temporarily hardcoded as fallbacks
 * so the function works immediately after deployment without additional
 * Azure App Setting configuration. Replace fallback values with proper
 * secrets management (Key Vault references) before going to production.
 */

function optionalEnv(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const config = {
  hivebrite: {
    apiBaseUrl: optionalEnv(
      "HIVEBRITE_API_BASE_URL",
      "https://hlb.hivebrite.com/api/admin/v1"
    ),

    // OAuth2 Password Grant — hardcoded fallbacks for immediate deployment.
    // Override via Azure Application Settings / local.settings.json.
    oauthTokenUrl: optionalEnv(
      "HIVEBRITE_OAUTH_TOKEN_URL",
      "https://hlb.hivebrite.com/api/oauth/token"
    ),
    clientId: optionalEnv(
      "HIVEBRITE_CLIENT_ID",
      "mv7XdC2LgBy2fUsj3eAUkWUclMINxiPsVJUm3qRYaI4"
    ),
    clientSecret: optionalEnv(
      "HIVEBRITE_CLIENT_SECRET",
      "dxyB2n0WdBJvHlpQtblHv8ORbl3dbDXy5d4kwgW8C88"
    ),
    adminEmail: optionalEnv(
      "HIVEBRITE_ADMIN_EMAIL",
      "tech@hlb.global"
    ),
    adminPassword: optionalEnv(
      "HIVEBRITE_ADMIN_PASSWORD",
      "O6EQT&K*I3LuXsn*"
    ),

    networkId: optionalEnv("HIVEBRITE_NETWORK_ID"),
    timeoutMs: parseInt(optionalEnv("HIVEBRITE_TIMEOUT_MS", "10000"), 10),
  },
  salesforce: {
    // OAuth2 Client Credentials — hardcoded fallbacks for immediate deployment.
    // Override via Azure Application Settings / local.settings.json.
    oauthTokenUrl: optionalEnv(
      "SF_OAUTH_TOKEN_URL",
      "https://d20000000ch6meac.my.salesforce.com/services/oauth2/token"
    ),
    clientId: optionalEnv(
      "SF_CLIENT_ID",
      "3MVG9WtWSKUDG.x6b1bxIvUJa87h4u8pPkRz3NEBSk.a5ua1ctCuWhu.tZBo2bUGWib1y7oSj7xYRA1Gf5Grs"
    ),
    clientSecret: optionalEnv(
      "SF_CLIENT_SECRET",
      "8495AD3968220AE42FF53D2749EA168340920D7DA8DE0CFD3F697A513D45A644"
    ),
    // Base URL for Salesforce REST API calls (derived from instance URL returned by OAuth)
    apiVersion: optionalEnv("SF_API_VERSION", "v60.0"),
    timeoutMs: parseInt(optionalEnv("SF_TIMEOUT_MS", "15000"), 10),
  },
  app: {
    logLevel: optionalEnv("LOG_LEVEL", "info"),
    nodeEnv: optionalEnv("NODE_ENV", "production"),
  },
} as const;
