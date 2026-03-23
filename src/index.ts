/**
 * Azure Functions v4 entry point.
 * Importing the functions module causes all `app.http(...)` / `app.timer(...)` registrations to run.
 */
import "./functions/syncSalesforceUser";
import "./functions/getSalesforceUsers";
import "./functions/getHivebriteUsers";
import "./functions/getSalesforceContacts";
