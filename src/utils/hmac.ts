import crypto from "crypto";

/**
 * Verifies the HMAC-SHA256 signature sent by Salesforce.
 *
 * Salesforce (via Apex HTTP callout) should include:
 *   X-SF-Signature: sha256=<hex-digest>
 *
 * @param secret     - Shared secret stored in SF_WEBHOOK_SECRET env var
 * @param rawBody    - Raw request body string (before JSON.parse)
 * @param signature  - Value of the X-SF-Signature header (e.g. "sha256=abc123")
 * @returns true if the signature is valid
 */
export function verifyHmacSignature(
  secret: string,
  rawBody: string,
  signature: string
): boolean {
  if (!signature) return false;

  const parts = signature.split("=");
  if (parts.length !== 2 || parts[0] !== "sha256") return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("hex");

  // Constant-time comparison to prevent timing attacks
  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(parts[1], "hex");

  if (expectedBuf.length !== providedBuf.length) return false;

  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}
