# hlb-sf-user-sync

A **serverless Azure Function** that bridges **Salesforce** and **Hivebrite**.

When a Salesforce user is created or updated, it calls this Azure Function endpoint which then upserts the user on the Hivebrite community platform.

---

## Architecture

```
Salesforce (Apex Callout / Outbound Message)
        │
        │  POST /api/sync/salesforce-user
        │  Header: X-SF-Signature: sha256=<hmac>
        ▼
Azure Function (HTTP Trigger)
  ├── Verify HMAC-SHA256 signature
  ├── Validate & parse Salesforce user payload (Zod)
  ├── Map SF fields → Hivebrite fields
  └── Upsert user via Hivebrite Admin API
        │
        ▼
   Hivebrite API
```

---

## Project Structure

```
hlb-sf-user-sync/
├── src/
│   ├── config/
│   │   └── env.ts                   # Validated env config (fails fast at startup)
│   ├── functions/
│   │   └── syncSalesforceUser.ts    # HTTP Trigger — main function + health check
│   ├── middleware/
│   │   └── auth.middleware.ts       # HMAC-SHA256 signature verification
│   ├── models/
│   │   ├── salesforce-user.model.ts # Zod schema + TypeScript types for SF payload
│   │   └── hivebrite-user.model.ts  # Zod schema + TypeScript types for HB payload
│   ├── services/
│   │   ├── hivebrite.service.ts     # Hivebrite Admin API client (upsert logic)
│   │   └── user-mapper.service.ts   # Maps SF user fields → Hivebrite fields
│   ├── utils/
│   │   ├── errors.ts                # Custom error classes + normaliseError helper
│   │   ├── hmac.ts                  # HMAC-SHA256 verification utility
│   │   └── logger.ts                # Winston structured logger
│   └── index.ts                     # Azure Functions v4 entry point
├── host.json                        # Azure Functions host configuration
├── local.settings.json              # Local dev settings (not committed)
├── .env.example                     # Template for environment variables
├── tsconfig.json
└── package.json
```

---

## Endpoints

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `POST` | `/api/sync/salesforce-user` | Function key + HMAC | Sync a Salesforce user to Hivebrite |
| `GET`  | `/api/health` | Anonymous | Health check |

---

## Setup

### Prerequisites

- [Node.js 20 LTS](https://nodejs.org/)
- [Azure Functions Core Tools v4](https://learn.microsoft.com/en-us/azure/azure-functions/functions-run-local)
- [Azurite](https://learn.microsoft.com/en-us/azure/storage/common/storage-use-azurite) (local storage emulator) or an Azure Storage account

```bash
npm install -g azure-functions-core-tools@4 --unsafe-perm true
npm install -g azurite
```

### Local Development

1. **Clone & install dependencies**

   ```bash
   git clone <repo>
   cd hlb-sf-user-sync
   npm install
   ```

2. **Configure environment variables**

   Copy `.env.example` to `local.settings.json` and fill in your values:

   ```json
   {
     "IsEncrypted": false,
     "Values": {
       "AzureWebJobsStorage": "UseDevelopmentStorage=true",
       "FUNCTIONS_WORKER_RUNTIME": "node",
       "HIVEBRITE_API_BASE_URL": "https://YOUR_COMMUNITY.hivebrite.com/api/admin/v1",
       "HIVEBRITE_API_TOKEN": "your-token",
       "HIVEBRITE_NETWORK_ID": "your-network-id",
       "SF_WEBHOOK_SECRET": "your-shared-secret",
       "LOG_LEVEL": "debug",
       "NODE_ENV": "development"
     }
   }
   ```

3. **Start Azurite** (in a separate terminal)

   ```bash
   azurite --silent --location /tmp/azurite --debug /tmp/azurite/debug.log
   ```

4. **Build & start the function**

   ```bash
   npm run build
   func start
   ```

   You should see:
   ```
   Functions:
       syncSalesforceUser: [POST] http://localhost:7071/api/sync/salesforce-user
       healthCheck:        [GET]  http://localhost:7071/api/health
   ```

### Testing Locally

**Health check:**
```bash
curl http://localhost:7071/api/health
```

**Sync endpoint (with valid HMAC):**

Generate a test HMAC signature:
```bash
SECRET="your-shared-secret"
BODY='{"user":{"Id":"005000000000001","Email":"jane.doe@example.com","FirstName":"Jane","LastName":"Doe","IsActive":true,"EventType":"created"}}'
SIG="sha256=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')"

curl -X POST http://localhost:7071/api/sync/salesforce-user \
  -H "Content-Type: application/json" \
  -H "X-SF-Signature: $SIG" \
  -d "$BODY"
```

---

## Salesforce Integration

### Option A: Apex HTTP Callout (recommended)

Create an Apex trigger on the `User` object that fires on insert/update and calls this Azure Function:

```apex
public class SalesforceUserSyncCallout {
    private static final String ENDPOINT = 'callout:AzureUserSync/api/sync/salesforce-user';
    private static final String SECRET = '{!$Credential.AzureSync.Secret}'; // Named Credential

    @future(callout=true)
    public static void syncUser(String userId) {
        User u = [
            SELECT Id, Email, FirstName, LastName, Title, Department,
                   CompanyName, Phone, MobilePhone, Street, City,
                   State, PostalCode, Country, IsActive
            FROM User WHERE Id = :userId LIMIT 1
        ];

        String eventType = Trigger.isInsert ? 'created' : 'updated';

        Map<String, Object> payload = new Map<String, Object>{
            'user' => new Map<String, Object>{
                'Id'          => u.Id,
                'Email'       => u.Email,
                'FirstName'   => u.FirstName,
                'LastName'    => u.LastName,
                'Title'       => u.Title,
                'Department'  => u.Department,
                'CompanyName' => u.CompanyName,
                'Phone'       => u.Phone,
                'MobilePhone' => u.MobilePhone,
                'Street'      => u.Street,
                'City'        => u.City,
                'State'       => u.State,
                'PostalCode'  => u.PostalCode,
                'Country'     => u.Country,
                'IsActive'    => u.IsActive,
                'EventType'   => eventType
            }
        };

        String body = JSON.serialize(payload);

        // Compute HMAC-SHA256 signature
        Blob hmacBlob = Crypto.generateMac(
            'HmacSHA256',
            Blob.valueOf(body),
            Blob.valueOf(SECRET)
        );
        String signature = 'sha256=' + EncodingUtil.convertToHex(hmacBlob);

        HttpRequest req = new HttpRequest();
        req.setEndpoint(ENDPOINT);
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/json');
        req.setHeader('X-SF-Signature', signature);
        req.setBody(body);
        req.setTimeout(30000);

        Http http = new Http();
        HttpResponse res = http.send(req);

        if (res.getStatusCode() != 200) {
            System.debug('Sync failed: ' + res.getBody());
        }
    }
}
```

### Option B: Salesforce Outbound Messages

Use Salesforce Workflow Rules or Process Builder to send an Outbound Message to the Azure Function URL when a User record is created or updated. Note: Outbound Messages use SOAP format, so you'd need to extend the payload parser.

---

## Deployment to Azure

### 1. Create Azure Resources

```bash
# Resource Group
az group create --name rg-hlb-sf-user-sync --location eastus

# Storage Account
az storage account create \
  --name sthlbsfusersync \
  --resource-group rg-hlb-sf-user-sync \
  --sku Standard_LRS

# Function App (Node.js 20)
az functionapp create \
  --resource-group rg-hlb-sf-user-sync \
  --consumption-plan-location eastus \
  --runtime node \
  --runtime-version 20 \
  --functions-version 4 \
  --name func-hlb-sf-user-sync \
  --storage-account sthlbsfusersync \
  --os-type Linux
```

### 2. Configure Application Settings

```bash
az functionapp config appsettings set \
  --name func-hlb-sf-user-sync \
  --resource-group rg-hlb-sf-user-sync \
  --settings \
    HIVEBRITE_API_BASE_URL="https://YOUR_COMMUNITY.hivebrite.com/api/admin/v1" \
    HIVEBRITE_API_TOKEN="your-token" \
    HIVEBRITE_NETWORK_ID="your-network-id" \
    SF_WEBHOOK_SECRET="your-shared-secret" \
    LOG_LEVEL="info" \
    NODE_ENV="production"
```

### 3. Build & Deploy

```bash
npm run build
func azure functionapp publish func-hlb-sf-user-sync
```

### 4. Get the Function URL

```bash
az functionapp function show \
  --name func-hlb-sf-user-sync \
  --resource-group rg-hlb-sf-user-sync \
  --function-name syncSalesforceUser \
  --query "invokeUrlTemplate"
```

The URL format will be:
```
https://func-hlb-sf-user-sync.azurewebsites.net/api/sync/salesforce-user?code=<function-key>
```

---

## Security

| Mechanism | Description |
|-----------|-------------|
| **Function Key** | Azure-level API key appended to the URL (`?code=...`) |
| **HMAC-SHA256** | Salesforce signs the request body with a shared secret; the function verifies it |
| **Input Validation** | All payloads are validated with Zod schemas before processing |
| **Structured Logging** | All requests logged with correlation IDs for auditability |
| **Environment Variables** | No secrets in code — all config via env vars / Azure App Settings |

---

## Field Mapping

| Salesforce Field | Hivebrite Field | Notes |
|-----------------|-----------------|-------|
| `Email` | `user.email` | Primary key for upsert |
| `FirstName` | `user.firstname` | |
| `LastName` | `user.lastname` | Required |
| `Title` | `user.headline` | |
| `Phone` | `user.phone_number` | |
| `MobilePhone` | `user.mobile_phone_number` | |
| `IsActive` | `user.enabled` | |
| `Street/City/State/PostalCode/Country` | `user.address.*` | |
| `Id` | `custom_fields.salesforce_id` | For cross-referencing |
| `Department` | `custom_fields.department` | |
| `CompanyName` | `custom_fields.company` | |
| `Division` | `custom_fields.division` | |

Extend `src/services/user-mapper.service.ts` to add additional field mappings.
