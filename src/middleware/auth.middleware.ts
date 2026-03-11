import { HttpRequest } from "@azure/functions";
import { config } from "../config/env";
import { verifyHmacSignature } from "../utils/hmac";
import { AuthError } from "../utils/errors";
import logger from "../utils/logger";

/**
 * Validates the HMAC-SHA256 signature from the incoming Salesforce webhook request.
 *
 * In your Salesforce Apex callout, compute:
 *   String signature = 'sha256=' + EncodingUtil.convertToHex(
 *     Crypto.generateMac('HmacSHA256', Blob.valueOf(requestBody), Blob.valueOf(secret))
 *   );
 * Then add header:  X-SF-Signature: <signature>
 *
 * @throws AuthError when the signature is missing or invalid
 */
export async function validateSalesforceSignature(
  request: HttpRequest,
  rawBody: string
): Promise<void> {
  const signature = request.headers.get("x-sf-signature") ?? "";

  if (!signature) {
    logger.warn("Missing X-SF-Signature header", {
      ip: request.headers.get("x-forwarded-for"),
    });
    throw new AuthError("Missing X-SF-Signature header");
  }

  const isValid = verifyHmacSignature(
    config.salesforce.webhookSecret,
    rawBody,
    signature
  );

  if (!isValid) {
    logger.warn("Invalid X-SF-Signature — possible spoofed request", {
      ip: request.headers.get("x-forwarded-for"),
    });
    throw new AuthError("Invalid webhook signature");
  }
}
