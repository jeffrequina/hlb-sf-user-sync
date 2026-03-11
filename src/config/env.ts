/**
 * Centralised, validated environment configuration.
 * Fails fast at startup if required variables are missing.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
      `Check your local.settings.json (local) or Azure Application Settings (production).`
    );
  }
  return value;
}

function optionalEnv(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const config = {
  hivebrite: {
    apiBaseUrl: requireEnv("HIVEBRITE_API_BASE_URL"),
    apiToken: requireEnv("HIVEBRITE_API_TOKEN"),
    networkId: optionalEnv("HIVEBRITE_NETWORK_ID"),
    /** Timeout in ms for Hivebrite API calls */
    timeoutMs: parseInt(optionalEnv("HIVEBRITE_TIMEOUT_MS", "10000"), 10),
  },
  salesforce: {
    webhookSecret: requireEnv("SF_WEBHOOK_SECRET"),
  },
  app: {
    logLevel: optionalEnv("LOG_LEVEL", "info"),
    nodeEnv: optionalEnv("NODE_ENV", "production"),
  },
} as const;
