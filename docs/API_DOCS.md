# ELYVN Bridge API Documentation

Complete reference for all API endpoints and webhooks. The bridge server acts as a middleware between external services (Retell AI, Twilio, Cal.com, Telegram) and the ELYVN database.

**Server Base URL:** `http://localhost:3001` (or your deployed domain)

---

## Authentication

### API Key Authentication (Required for protected endpoints)

Protected API endpoints require the `x-api-key` header:

```bash
curl -H "x-api-key: YOUR_API_KEY" https://your-domain/api/stats/CLIENT_ID
```

**API Key Levels:**
- **Global Admin Key** (`ELYVN_API_KEY` env var) - Full access to all endpoints
- **Per-Client Keys** - Stored in database with role-based permissions (`read`, `write`)
- **Development Mode** - If no `ELYVN_API_KEY` is set and `NODE_ENV !== 'production'`, API auth is skipped

**Key Management:**
- Keys are stored hashed (SHA256) in `client_api_keys` table
- Each key tracks `last_used_at` timestamp
- Keys can expire via `expires_at` field
- Use `POST /api/clients/:clientId/keys` to generate new keys (when implemented)

### Webhook Authentication (No API key required)

Webhooks use signature verification instead:
- **Retell**: `x-retell-signature` (HMAC-SHA256)
- **Twilio**: `x-twilio-signature` (HMAC-SHA1)
- **Telegram**: `x-telegram-bot-api-secret-token` (Bearer token)
- **Cal.com**: No signature (webhook secret configured in Cal.com dashboard)

---

## Rate Limiting

All endpoints are subject to **120 requests per 60 seconds** per client/IP.

**Rate Limit Headers:**
```
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1609459200
Retry-After: 30
```

**429 Response (Rate Limited):**
```json
{
  "error": "Too many requests",
  "retry_after": 30
}
```

---

## Public Endpoints (No Auth Required)

### Health Check
```
GET /health
```
Returns system status, database health, environment configuration.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2025-03-25T10:30:45Z",
  "uptime_seconds": 3600,
  "memory": {
    "rss_mb": 250,
    "heap_used_mb": 120,
    "heap_total_mb": 180
  },
  "services": { "db": true },
  "database": {
    "status": "connected",
    "adapter": "sqlite",
    "size_mb": 45.2,
    "wal_mode": true
  },
  "db_counts": {
    "clients": 5,
    "calls": 1250,
    "leads": 340,
    "messages": 890,
    "followups": 120,
    "pending_jobs": 5
  },
  "env_configured": {
    "ANTHROPIC_API_KEY": true,
    "RETELL_API_KEY": true,
    "TWILIO_ACCOUNT_SID": true,
    "ELYVN_API_KEY": false
  }
}
```

### Metrics Endpoint
```
GET /metrics [AUTH REQUIRED]
```
Internal metrics for monitoring system performance.

---

## Onboarding Endpoints

### Complete Client Onboarding
```
POST /api/onboard
Content-Type: application/json
Rate Limit: 5 requests per minute per IP
```

**Request Body:**
```json
{
  "business_name": "ABC Plumbing",
  "owner_name": "John Smith",
  "owner_phone": "+15551234567",
  "owner_email": "john@abc-plumbing.com",
  "industry": "Plumbing",
  "services": ["Emergency Repairs", "Maintenance"],
  "business_hours": "Mon-Fri 8am-6pm EST",
  "avg_ticket": 250,
  "booking_link": "https://cal.com/abc-plumbing/demo",
  "faq": [
    {
      "question": "Do you offer emergency service?",
      "answer": "Yes, 24/7 emergency service available."
    }
  ]
}
```

**Required Fields:** `business_name`, `owner_name`, `owner_phone`, `owner_email`, `industry`, `services`

**Response (201 Created):**
```json
{
  "success": true,
  "client_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "active",
  "kb_generated": true,
  "next_steps": [
    "Configure Retell agent",
    "Setup Twilio phone number",
    "Add Cal.com booking integration"
  ],
  "webhook_urls": {
    "retell": "https://your-domain/webhooks/retell",
    "twilio": "https://your-domain/webhooks/twilio",
    "calcom": "https://your-domain/webhooks/calcom",
    "telegram": "https://your-domain/webhooks/telegram",
    "form": "https://your-domain/webhooks/form"
  },
  "embed_code": "<script src='https://your-domain/embed.js' data-client-id='550e8400-e29b-41d4-a716-446655440000'></script>"
}
```

**Error Responses:**
- `400` - Missing required fields or validation error
- `429` - Rate limit exceeded

---

## API Endpoints (Auth Required - x-api-key header)

### Client Management

#### List All Clients
```
GET /api/clients
```
**Response:**
```json
{
  "clients": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "business_name": "ABC Plumbing",
      "owner_name": "John Smith",
      "owner_email": "john@abc-plumbing.com",
      "industry": "Plumbing",
      "is_active": true,
      "timezone": "America/New_York",
      "created_at": "2025-03-20T10:00:00Z"
    }
  ]
}
```

#### Create Client
```
POST /api/clients
Content-Type: application/json
```
**Request Body:** (same as onboarding)

#### Update Client
```
PUT /api/clients/:clientId
Content-Type: application/json
```
**Request Body:**
```json
{
  "business_name": "ABC Plumbing Services",
  "avg_ticket": 300,
  "is_active": true,
  "retell_agent_id": "agent_123",
  "retell_phone": "+15559876543",
  "twilio_phone": "+15551234567",
  "calcom_booking_link": "https://cal.com/abc-plumbing/service",
  "timezone": "America/Los_Angeles"
}
```

---

### Statistics & Reporting

#### Get Client Statistics
```
GET /api/stats/:clientId
Query Parameters: (none)
```

**Response:**
```json
{
  "calls_this_week": 15,
  "calls_last_week": 12,
  "calls_trend": 25,
  "messages_this_week": 42,
  "messages_last_week": 38,
  "messages_trend": 10,
  "bookings_this_week": 3,
  "estimated_revenue": 750,
  "leads_by_stage": {
    "new": 25,
    "contacted": 10,
    "qualified": 5,
    "booked": 8,
    "completed": 3,
    "lost": 2
  }
}
```

#### Get Weekly Reports
```
GET /api/reports/:clientId
```

**Response:**
```json
{
  "reports": [
    {
      "id": "report_uuid",
      "client_id": "client_uuid",
      "week_start": "2025-03-17",
      "calls_count": 15,
      "messages_count": 42,
      "bookings_count": 3,
      "missed_calls": 2,
      "avg_call_duration": 245,
      "sentiment_summary": "positive",
      "created_at": "2025-03-24"
    }
  ]
}
```

---

### Calls

#### List Calls
```
GET /api/calls/:clientId
Query Parameters:
  - outcome: "booked" | "missed" | "transferred" | "voicemail" (optional)
  - startDate: ISO timestamp (optional)
  - endDate: ISO timestamp (optional)
  - minScore: number 0-100 (optional)
  - page: number (default: 1)
  - limit: number 1-100 (default: 20)
```

**Response:**
```json
{
  "calls": [
    {
      "id": "call_uuid",
      "call_id": "retell_call_id",
      "caller_phone": "+15551234567",
      "direction": "inbound",
      "duration": 245,
      "outcome": "booked",
      "summary": "Customer called about emergency repair, scheduled appointment.",
      "score": 92,
      "sentiment": "positive",
      "created_at": "2025-03-25T10:15:00Z"
    }
  ],
  "total": 156,
  "page": 1,
  "limit": 20,
  "total_pages": 8
}
```

#### Get Call Transcript
```
GET /api/calls/:clientId/:callId/transcript
```

**Response:**
```json
{
  "transcript": [
    {
      "role": "agent",
      "content": "Hi, thanks for calling ABC Plumbing. How can I help you?"
    },
    {
      "role": "user",
      "content": "I have a burst pipe."
    }
  ]
}
```

---

### Messages

#### List Messages
```
GET /api/messages/:clientId
Query Parameters:
  - status: "inbound" | "outbound" (optional)
  - startDate: ISO timestamp (optional)
  - endDate: ISO timestamp (optional)
  - page: number (default: 1)
  - limit: number 1-100 (default: 20)
```

**Response:**
```json
{
  "messages": [
    {
      "id": "msg_uuid",
      "client_id": "client_uuid",
      "phone": "+15551234567",
      "channel": "sms" | "telegram" | "form_reply",
      "direction": "inbound" | "outbound",
      "body": "Thanks for reaching out!",
      "reply_text": "Can you send more details?",
      "reply_classification": "interested" | "not_interested" | "qualified",
      "status": "sent" | "delivered" | "failed",
      "created_at": "2025-03-25T10:15:00Z"
    }
  ],
  "total": 890,
  "page": 1,
  "limit": 20,
  "total_pages": 45
}
```

---

### Leads

#### List Leads
```
GET /api/leads/:clientId
Query Parameters:
  - stage: "new" | "contacted" | "qualified" | "booked" | "completed" | "lost" (optional)
  - minScore: number 0-100 (optional)
  - search: string (searches name, phone, email) (optional)
  - page: number (default: 1)
  - limit: number 1-100 (default: 20)
```

**Response:**
```json
{
  "leads": [
    {
      "id": "lead_uuid",
      "client_id": "client_uuid",
      "phone": "+15551234567",
      "email": "john@example.com",
      "name": "John Smith",
      "service": "Emergency Repair",
      "source": "missed_call" | "form" | "sms_inbound",
      "stage": "qualified",
      "score": 85,
      "sentiment": "positive",
      "recent_calls": [
        {
          "id": "call_uuid",
          "call_id": "retell_call_id",
          "duration": 245,
          "outcome": "booked",
          "summary": "...",
          "score": 92,
          "created_at": "2025-03-25T10:15:00Z"
        }
      ],
      "recent_messages": [
        {
          "id": "msg_uuid",
          "direction": "inbound",
          "body": "Yes, I can make 3pm tomorrow",
          "created_at": "2025-03-25T10:20:00Z"
        }
      ],
      "created_at": "2025-03-25T08:00:00Z",
      "updated_at": "2025-03-25T10:20:00Z"
    }
  ],
  "total": 340,
  "page": 1,
  "limit": 20,
  "total_pages": 17
}
```

#### Update Lead
```
PUT /api/leads/:clientId/:leadId
Content-Type: application/json
```

**Request Body:**
```json
{
  "stage": "qualified"
}
```

**Valid Stages:** `new`, `contacted`, `qualified`, `booked`, `completed`, `lost`

**Response:**
```json
{
  "success": true,
  "stage": "qualified"
}
```

---

### Bookings

#### List Cal.com Bookings
```
GET /api/bookings/:clientId
Query Parameters:
  - startDate: ISO timestamp (optional)
  - endDate: ISO timestamp (optional)
```

**Response:**
```json
{
  "bookings": [
    {
      "id": "booking_uuid",
      "title": "Service Appointment",
      "startTime": "2025-03-26T15:00:00Z",
      "endTime": "2025-03-26T15:30:00Z",
      "attendees": [
        {
          "name": "John Smith",
          "email": "john@example.com",
          "phone": "+15551234567"
        }
      ],
      "status": "confirmed" | "cancelled",
      "timezone": "America/New_York"
    }
  ]
}
```

---

## Webhook Endpoints (No Auth Required)

### Retell AI Webhooks
```
POST /webhooks/retell
POST /retell-webhook
Header: x-retell-signature (signature verification)
```

**Handles Events:**
- `call_started` - New inbound or outbound call initiated
- `call_ended` - Call disconnected (captures duration, end reason)
- `call_analyzed` - AI analysis complete (summary, sentiment, booking status)
- `agent_transfer` / `transfer_requested` - User pressed * to transfer
- `dtmf` - Dual-tone multi-frequency input (digit pressed)

**Webhook Payload Example (call_analyzed):**
```json
{
  "event": "call_analyzed",
  "call": {
    "call_id": "retell_call_uuid",
    "from_number": "+15551234567",
    "to_number": "+15559876543",
    "direction": "inbound",
    "duration_secs": 245,
    "end_reason": "customer_hangup" | "agent_hangup" | "transfer",
    "transcript": [{...}],
    "summary": "Customer called about emergency repair, scheduled appointment.",
    "sentiment": "positive",
    "booking_confirmed": true,
    "metadata": { "lead_id": "uuid", "client_id": "uuid" }
  }
}
```

**Response:** Always `200 OK` immediately (async processing)

---

### Twilio SMS Webhooks
```
POST /webhooks/twilio
Header: x-twilio-signature (signature verification)
Content-Type: application/x-www-form-urlencoded
```

**Webhook Payload:**
```
From=+15551234567
To=+15559876543
Body=Hi, can you help me with my AC?
MessageSid=SM123456789abc
```

**Response:** Empty TwiML
```xml
<Response></Response>
```

**Handling:** Inbound SMS are stored in `messages` table, classified, and trigger lead actions.

---

### Form Submission Webhooks
```
POST /webhooks/form
Content-Type: application/json
Rate Limit: 10 requests per 60 seconds per IP
```

**Request Body (flexible field names):**
```json
{
  "client_id": "client_uuid",
  "name": "John Smith",
  "email": "john@example.com",
  "phone": "+15551234567",
  "message": "I need emergency plumbing service",
  "service": "Emergency Repair"
}
```

**Flexible Field Name Mappings:**
- Phone: `phone`, `Phone`, `tel`, `mobile`, `your-phone`
- Email: `email`, `Email`, `your-email`
- Name: `name`, `first_name`, `fullName`, `full_name`, `your-name`
- Message: `message`, `Message`, `body`, `inquiry`, `your-message`

**Response:** Always `200 OK` immediately
```json
{
  "status": "received",
  "message": "Lead captured"
}
```

**Triggering:** Speed-to-lead sequence (SMS → AI callback → followup SMS)

---

### Cal.com Booking Webhooks
```
POST /webhooks/calcom
Content-Type: application/json
```

**Handles Events:**
- `BOOKING_CREATED` - Customer booked an appointment
- `BOOKING_CANCELLED` - Customer cancelled
- `BOOKING_RESCHEDULED` - Customer rescheduled

**Webhook Payload (BOOKING_CREATED):**
```json
{
  "triggerEvent": "BOOKING_CREATED",
  "payload": {
    "bookingId": 123456,
    "uid": "booking_uuid",
    "title": "Service Appointment",
    "startTime": "2025-03-26T15:00:00Z",
    "endTime": "2025-03-26T15:30:00Z",
    "attendees": [
      {
        "name": "John Smith",
        "email": "john@example.com",
        "phone": "+15551234567"
      }
    ],
    "organizer": {
      "name": "ABC Plumbing",
      "email": "business@abc-plumbing.com"
    },
    "metadata": {
      "phone": "+15551234567"
    }
  }
}
```

**Response:** Always `200 OK`
```json
{
  "received": true
}
```

**Handling:** Updates lead stage to `booked`, cancels pending speed-to-lead jobs.

---

### Telegram Bot Webhooks
```
POST /webhooks/telegram
Header: x-telegram-bot-api-secret-token (if configured)
Content-Type: application/json
```

**Handles:**
- `/stats` - Show lead stats (top leads by score, recent activity)
- `/leads` - Query leads by stage or search by name
- `/calls` - Show recent calls with outcomes and sentiments
- Inline buttons - Lead details, mark as booked, etc.

**Webhook Payload (message):**
```json
{
  "update_id": 123456789,
  "message": {
    "message_id": 1,
    "from": {
      "id": 12345678,
      "is_bot": false,
      "first_name": "John"
    },
    "chat": {
      "id": 12345678,
      "type": "private"
    },
    "text": "/stats"
  }
}
```

**Response:** Always `200 OK` immediately

---

## Email Tracking

### Open Tracking Pixel
```
GET /t/open/:emailId
```

Returns 1x1 transparent GIF. Increments `open_count` and sets `opened_at` in `emails_sent` table.

**Usage:**
```html
<img src="https://your-domain/t/open/550e8400-e29b-41d4-a716-446655440000" alt="" style="width: 1px; height: 1px;">
```

---

### Click Tracking Redirect
```
GET /t/click/:emailId?url=https://example.com
```

Redirects to URL after incrementing `click_count` and setting `clicked_at`.

**Usage:**
```html
<a href="https://your-domain/t/click/550e8400-e29b-41d4-a716-446655440000?url=https://example.com">
  Click here
</a>
```

---

## Outreach API (Auth Required)

### Scrape Business Prospects
```
POST /api/outreach/scrape
Content-Type: application/json
x-api-key: YOUR_API_KEY
```

**Request Body:**
```json
{
  "industry": "Plumber",
  "city": "San Francisco",
  "country": "USA",
  "maxResults": 20
}
```

**Response:**
```json
{
  "prospects": [
    {
      "id": "prospect_uuid",
      "name": "ABC Plumbing",
      "phone": "+15551234567",
      "email": "contact@abc-plumbing.com",
      "website": "https://abc-plumbing.com",
      "address": "123 Main St, San Francisco, CA",
      "rating": 4.5,
      "review_count": 42
    }
  ],
  "total": 20
}
```

**Note:** Requires `GOOGLE_MAPS_API_KEY` environment variable (Google Places API)

---

### Send Campaign Email
```
POST /api/outreach/send-campaign
Content-Type: application/json
x-api-key: YOUR_API_KEY
```

**Request Body:**
```json
{
  "prospect_ids": ["prospect_uuid_1", "prospect_uuid_2"],
  "template": "cold_outreach",
  "subject": "Quick question about {{business_name}}",
  "body": "Hi {{first_name}},\n\nI help {{industry}} businesses...",
  "from_name": "Sohan",
  "from_email": "outreach@elyvn.com",
  "reply_to": "demo@elyvn.com"
}
```

**Response:**
```json
{
  "sent": 2,
  "failed": 0,
  "campaign_id": "campaign_uuid",
  "tracking": {
    "opens": "https://your-domain/t/open/EMAIL_ID",
    "clicks": "https://your-domain/t/click/EMAIL_ID?url=YOUR_URL"
  }
}
```

---

### Auto-Classify Email Replies
```
POST /api/outreach/auto-classify
Content-Type: application/json
x-api-key: YOUR_API_KEY
```

**Auto-runs every 5 minutes.** Classifies unclassified email replies using Anthropic API.

**Response:**
```json
{
  "classified": 12,
  "interested": 3,
  "not_interested": 5,
  "not_qualified": 4
}
```

---

## Error Handling

All error responses follow this format:

```json
{
  "error": "Description of what went wrong",
  "details": "Additional context (optional)"
}
```

**Common HTTP Status Codes:**

| Code | Meaning |
|------|---------|
| `200` | Success |
| `201` | Created |
| `400` | Bad request (validation error) |
| `401` | Unauthorized (missing/invalid API key) |
| `403` | Forbidden (insufficient permissions) |
| `404` | Not found |
| `429` | Rate limited |
| `500` | Server error |

---

## Curl Examples

### Get Client Stats
```bash
curl -X GET \
  -H "x-api-key: your_api_key" \
  https://your-domain/api/stats/550e8400-e29b-41d4-a716-446655440000
```

### Create New Client
```bash
curl -X POST \
  -H "x-api-key: your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "business_name": "XYZ Services",
    "owner_name": "Jane Doe",
    "owner_phone": "+15551234567",
    "owner_email": "jane@xyz.com",
    "industry": "HVAC",
    "services": ["Installation", "Repair"],
    "avg_ticket": 500
  }' \
  https://your-domain/api/clients
```

### Onboard New Client (No Auth)
```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "business_name": "Quick Setup Co",
    "owner_name": "Bob Smith",
    "owner_phone": "+15559876543",
    "owner_email": "bob@quicksetup.com",
    "industry": "General Contracting",
    "services": ["Estimates", "Repairs"]
  }' \
  https://your-domain/api/onboard
```

### List Leads with Filters
```bash
curl -X GET \
  -H "x-api-key: your_api_key" \
  "https://your-domain/api/leads/550e8400-e29b-41d4-a716-446655440000?stage=qualified&minScore=80&page=1&limit=50"
```

### Submit Form Lead (No Auth)
```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "Sarah Johnson",
    "email": "sarah@company.com",
    "phone": "+15551234567",
    "message": "I need your services ASAP",
    "service": "Premium Package"
  }' \
  https://your-domain/webhooks/form
```

---

## Testing

Use these tools to test endpoints:
- **Postman** - Full API testing with environment variables
- **curl** - Command-line testing (examples above)
- **OpenAPI/Swagger** - Generate API docs from spec

---

## Support

For API issues:
1. Check the `/health` endpoint for service status
2. Review server logs: `docker logs elyvn-bridge`
3. Check database integrity: `sqlite3 elyvn.db .integrity_check`
4. Verify environment variables are set correctly
