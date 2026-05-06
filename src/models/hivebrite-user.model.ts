import { z } from "zod";

const PostalAddressSchema = z.object({
  address_1: z.string().optional(),
  address_2: z.string().optional(),
  address_3: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  full_name: z.string().optional(),
  postal_code: z.string().optional(),
  country: z.string().optional(),
});

const SkillSchema = z.object({
  id: z.number().optional(),
  name: z.string(),
});

/**
 * Hivebrite custom attribute entry.
 * Used to map multi-value fields (groups, industries, languages, skills).
 * The `value` array contains the individual string values split from the
 * comma-separated Salesforce field.
 */
const CustomAttributeSchema = z.object({
  name: z.string(),
  value: z.array(z.string()),
});

export type HivebriteCustomAttribute = z.infer<typeof CustomAttributeSchema>;

// Create User Payload
// Matches: POST /api/admin/v1/users
// Reference: src/docs/create-hivebrite-user.json

export const HivebriteCreateUserSchema = z.object({
  id: z.number().optional().default(0),
  email: z.string().email(),
  firstname: z.string().optional(),
  lastname: z.string().min(1),
  maidenname: z.string().optional(),
  is_active: z.boolean().optional().default(true),
  gender: z.enum(["male", "female", "other"]).optional(),
  birthday: z.string().optional(),
  birthplace: z.string().optional(),
  headline: z.string().optional(),
  summary: z.string().optional(),

  // Phone numbers — Hivebrite separates personal/professional mobile and landline
  mobile_perso: z.string().optional(),
  mobile_pro: z.string().optional(),
  landline_perso: z.string().optional(),
  landline_pro: z.string().optional(),

  // Addresses
  postal_personal: PostalAddressSchema.optional(),
  postal_work: PostalAddressSchema.optional(),

  role_id: z.number().optional(),
  awards: z.string().optional(),
  linkedin_profile_url: z.string().optional(),
  website: z.string().optional(),
  twitter: z.string().optional(),
  timezone: z.string().optional(),
  facebook_profile_url: z.string().optional(),
  instagram_profile_url: z.string().optional(),
  honorary_title: z.enum(["mr", "mrs", "ms", "dr", "prof"]).optional(),
  resume: z.string().optional(),
  skills: z.array(SkillSchema).optional(),

  // External / SSO identifier — available on both create and update
  sso_identifier: z.string().optional(),

  // Custom profile attributes (multi-value fields like groups, industries, etc.)
  custom_attributes: z.array(CustomAttributeSchema).optional(),

  // Sub-network membership IDs. Must include at least one entry on create;
  // use [0] to assign to the default/root sub-network.
  sub_network_ids: z.array(z.number()).optional(),
});

export type HivebriteCreateUser = z.infer<typeof HivebriteCreateUserSchema>;

// Update User Payload
// Matches: PUT /api/admin/v1/users/{id}
// Reference: src/docs/update-hivebrite-user.json
// Update extends create and adds additional fields only available on update.

export const HivebriteUpdateUserSchema = HivebriteCreateUserSchema.extend({
  // id and email are not required for updates — user is identified by ID in the URL
  id: z.number().optional(),
  email: z.string().email().optional(),

  // Name prefix / suffix
  prefix_firstname: z.string().optional(),
  prefix_name: z.string().optional(),
  suffix_name: z.string().optional(),

  // External identifiers for cross-system sync (sso_identifier is on the base schema)
  external_id: z.string().optional(),
  previous_id: z.string().optional(),

  preferred_phone_number: z
    .enum(["mobile_pro", "mobile_perso", "landline_pro", "landline_perso"])
    .optional(),

  skype: z.string().optional(),
  bbm: z.string().optional(),
});

export type HivebriteUpdateUser = z.infer<typeof HivebriteUpdateUserSchema>;

// ── Legacy wrapper type (kept for backward compatibility with upsert logic) ───

/**
 * Union type used by the upsert helper — covers both create and update shapes.
 */
export type HivebriteUserPayload = HivebriteCreateUser | HivebriteUpdateUser;

// API Response shapes

export interface HivebriteUserResponse {
  id: number;
  email: string;
  name: string;
  firstname: string;
  lastname: string;
  is_active: boolean;
  headline?: string;
  summary?: string;
  linkedin_profile_url?: string;
  mobile_perso?: string;
  mobile_pro?: string;
  landline_perso?: string;
  landline_pro?: string;
  postal_personal?: {
    id: number;
    address_1: string;
    city: string;
    state: string;
    postal_code: string;
    country: string;
  };
  /** Custom profile attributes (groups, industries, languages, skills) */
  custom_attributes?: HivebriteCustomAttribute[];
  created_at: string;
  updated_at: string;
  /** Last activity-aware timestamp — used for the 15-minute moving-window filter */
  extended_updated_at?: string;
  [key: string]: unknown;
}

export interface HivebriteUsersListResponse {
  users: HivebriteUserResponse[];
  total_count: number;
  page: number;
  per_page: number;
}

export interface HivebriteApiError {
  errors: Record<string, string[]>;
  message?: string;
}
