import { SalesforceUser } from "../models/salesforce-user.model";
import { HivebriteUserPayload } from "../models/hivebrite-user.model";

/**
 * Maps a validated Salesforce user object into the Hivebrite user payload shape.
 *
 * Extend or adjust the field mappings below to match your Hivebrite
 * community's custom fields and data structure.
 */
export function mapSalesforceUserToHivebrite(
  sfUser: SalesforceUser
): HivebriteUserPayload {
  const customFields: Record<string, string | number | boolean> = {};

  if (sfUser.Id) customFields["salesforce_id"] = sfUser.Id;
  if (sfUser.Department) customFields["department"] = sfUser.Department;
  if (sfUser.CompanyName) customFields["company"] = sfUser.CompanyName;
  if (sfUser.Division) customFields["division"] = sfUser.Division;

  const hasAddress =
    sfUser.Street ||
    sfUser.City ||
    sfUser.State ||
    sfUser.PostalCode ||
    sfUser.Country;

  return {
    user: {
      email: sfUser.Email,
      firstname: sfUser.FirstName || "",
      lastname: sfUser.LastName,
      headline: sfUser.Title,
      phone_number: sfUser.Phone,
      mobile_phone_number: sfUser.MobilePhone,
      enabled: sfUser.IsActive,
      send_invite: false,
      custom_fields: Object.keys(customFields).length > 0
        ? customFields
        : undefined,
      address: hasAddress
        ? {
            street: sfUser.Street,
            city: sfUser.City,
            state: sfUser.State,
            zip_code: sfUser.PostalCode,
            country: sfUser.Country,
          }
        : undefined,
    },
  };
}
