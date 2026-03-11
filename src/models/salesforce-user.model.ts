import { z } from "zod";

/**
 * Zod schema for validating the Salesforce user webhook payload.
 * Salesforce sends user data via Outbound Messages or Apex HTTP callouts.
 */
export const SalesforceUserSchema = z.object({
  // Core identity
  Id: z.string().min(15).max(18),
  Username: z.string().email("Salesforce Username must be a valid email"),
  Email: z.string().email("Email must be valid"),
  FirstName: z.string().optional().default(""),
  LastName: z.string().min(1, "LastName is required"),

  // Profile / role
  Title: z.string().optional(),
  Department: z.string().optional(),
  CompanyName: z.string().optional(),
  Division: z.string().optional(),

  // Contact info
  Phone: z.string().optional(),
  MobilePhone: z.string().optional(),

  // Address
  Street: z.string().optional(),
  City: z.string().optional(),
  State: z.string().optional(),
  PostalCode: z.string().optional(),
  Country: z.string().optional(),

  // Status flags
  IsActive: z.boolean().default(true),

  // Timestamps
  CreatedDate: z.string().optional(),
  LastModifiedDate: z.string().optional(),

  // Event type sent by the caller (created | updated)
  EventType: z
    .enum(["created", "updated"])
    .default("updated"),
});

export type SalesforceUser = z.infer<typeof SalesforceUserSchema>;

/**
 * Envelope that Salesforce (or your Apex callout) wraps the user payload in.
 */
export const SalesforceWebhookPayloadSchema = z.object({
  user: SalesforceUserSchema,
});

export type SalesforceWebhookPayload = z.infer<
  typeof SalesforceWebhookPayloadSchema
>;
