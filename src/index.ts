/**
 * Azure Functions v4 entry point.
 * Importing each module causes its app.http() / app.timer() registrations to run.
 */
import "./functions/healthCheck";
import "./functions/getSalesforceContacts";
import "./functions/createHivebriteUsers";
