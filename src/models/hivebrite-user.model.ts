import { z } from "zod";

/**
 * Hivebrite user upsert payload.
 * Reference: https://developer.hivebrite.com/reference/post_api-admin-v1-users
 */
export const HivebriteUserPayloadSchema = z.object({
  user: z.object({
    email: z.string().email(),
    firstname: z.string().optional(),
    lastname: z.string().min(1),
    headline: z.string().optional(),
    phone_number: z.string().optional(),
    mobile_phone_number: z.string().optional(),

    // Custom fields map — Hivebrite allows arbitrary key/value custom fields
    custom_fields: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional(),

    // Address block
    address: z
      .object({
        street: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        zip_code: z.string().optional(),
        country: z.string().optional(),
      })
      .optional(),

    // Optional: send invitation email on creation
    send_invite: z.boolean().optional().default(false),

    // Whether the account should be active on Hivebrite
    enabled: z.boolean().optional().default(true),
  }),
});

export type HivebriteUserPayload = z.infer<typeof HivebriteUserPayloadSchema>;

/**
 * Hivebrite API response shape for a user object.
 */
export interface HivebriteUserResponse {
  id: number;
  email: string;
  firstname: string;
  lastname: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

/**
 * Hivebrite API error response shape.
 */
export interface HivebriteApiError {
  errors: Record<string, string[]>;
  message?: string;
}
