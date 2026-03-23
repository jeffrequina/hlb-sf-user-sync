import { SalesforceUser } from "../models/salesforce-user.model";
import { HivebriteCreateUser } from "../models/hivebrite-user.model";

/**
 * Maps a validated Salesforce User object to a Hivebrite create/update payload.
 *
 * Field mapping reference:
 *   SF Email          → HB email            (primary key for upsert)
 *   SF FirstName      → HB firstname
 *   SF LastName       → HB lastname
 *   SF Title          → HB headline
 *   SF Phone          → HB landline_pro
 *   SF MobilePhone    → HB mobile_pro
 *   SF IsActive       → HB is_active
 *   SF Street/City…   → HB postal_personal.*
 *   SF Id             → HB external_id      (for cross-system traceability)
 *
 * Extend this function to map additional fields as needed.
 */
export function mapSalesforceUserToHivebrite(
  sfUser: SalesforceUser
): HivebriteCreateUser {
  const hasPersonalAddress =
    sfUser.Street ||
    sfUser.City ||
    sfUser.State ||
    sfUser.PostalCode ||
    sfUser.Country;

  return {
    id: 0,
    email: sfUser.Email,
    firstname: sfUser.FirstName || "",
    lastname: sfUser.LastName,
    headline: sfUser.Title,

    // Map SF phone fields to Hivebrite professional phone fields
    landline_pro: sfUser.Phone,
    mobile_pro: sfUser.MobilePhone,

    is_active: sfUser.IsActive,

    // Map SF address to Hivebrite personal address block
    postal_personal: hasPersonalAddress
      ? {
          address_1: sfUser.Street,
          city: sfUser.City,
          state: sfUser.State,
          postal_code: sfUser.PostalCode,
          country: sfUser.Country,
        }
      : undefined,

    locale: "en",
  };
}
