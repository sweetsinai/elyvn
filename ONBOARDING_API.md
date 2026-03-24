# Client Onboarding API

The onboarding endpoint provides a single atomic call to register a new client on the ELYVN platform with automatic knowledge base generation and webhook configuration.

## Endpoint

```
POST /api/onboard
```

## Authentication

The onboarding endpoint is **publicly accessible** (no API key required). This allows clients to self-register. For production, consider adding rate limiting or CORS restrictions.

## Request Body

All fields are JSON in the request body.

### Required Fields

- **business_name** (string): Client's business name
  - Example: `"Smith's Plumbing Services"`

- **owner_name** (string): Business owner's full name
  - Example: `"John Smith"`

- **owner_phone** (string): Contact phone number
  - Example: `"+1-555-123-4567"` or `"5551234567"`

- **owner_email** (string): Valid email address for owner
  - Example: `"john@smithsplumbing.com"`
  - Must be a valid email format

- **industry** (string): Business industry/category
  - Example: `"Plumbing"`, `"HVAC"`, `"Electric"`, `"Landscaping"`

- **services** (array of strings): Services offered by the business
  - Example: `["Emergency repairs", "Maintenance", "Installation", "Inspection"]`
  - Must be non-empty array

### Optional Fields

- **business_hours** (string): Operating hours
  - Example: `"Mon-Fri 8am-6pm, Sat 9am-2pm"`
  - Shown to callers during IVR greeting

- **avg_ticket** (number): Average job/service value in dollars
  - Example: `150.00`
  - Used for revenue estimation

- **booking_link** (string): Cal.com or other booking platform link
  - Example: `"https://calendly.com/john-smith"`
  - Provided to callers for self-service booking

- **faq** (array of objects): Frequently asked questions
  - Each object: `{ "question": "...", "answer": "..." }`
  - Example:
    ```json
    [
      {
        "question": "What are your service areas?",
        "answer": "We serve the greater metro area within a 30-mile radius"
      },
      {
        "question": "Do you offer emergency service?",
        "answer": "Yes, we have 24/7 emergency service available"
      }
    ]
    ```

## Request Example

```bash
curl -X POST http://localhost:3001/api/onboard \
  -H "Content-Type: application/json" \
  -d '{
    "business_name": "Smith Plumbing Services",
    "owner_name": "John Smith",
    "owner_phone": "+1-555-123-4567",
    "owner_email": "john@smithsplumbing.com",
    "industry": "Plumbing",
    "services": [
      "Emergency repairs",
      "Drain cleaning",
      "Water heater replacement",
      "Fixture installation"
    ],
    "business_hours": "Mon-Fri 8am-6pm, Sat 9am-2pm",
    "avg_ticket": 150,
    "booking_link": "https://calendly.com/john-smith",
    "faq": [
      {
        "question": "Do you offer emergency service?",
        "answer": "Yes, we have 24/7 emergency service. Call our emergency line."
      },
      {
        "question": "What is your service area?",
        "answer": "We serve the entire county and surrounding areas."
      }
    ]
  }'
```

## Response

### Success (201 Created)

```json
{
  "success": true,
  "client_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "active",
  "kb_generated": true,
  "kb_path": "server/mcp/knowledge_bases/550e8400-e29b-41d4-a716-446655440000.json",
  "next_steps": [
    "1. Connect Retell AI voice agent: Visit https://retell.ai and create an agent with the provided knowledge base",
    "2. Configure Twilio: Add SMS/voice phone number and set webhook to https://yourdomain.com/webhooks/twilio",
    "3. Set up Telegram bot: Configure your bot webhook at https://yourdomain.com/webhooks/telegram",
    "4. Add Cal.com booking link: Update client record with calcom_booking_link for auto-booking",
    "5. Embed on website: Add the provided embed code to your website",
    "6. Test the system: Make a call or send an SMS to verify integration"
  ],
  "webhook_urls": {
    "twilio": "https://yourdomain.com/webhooks/twilio",
    "telegram": "https://yourdomain.com/webhooks/telegram",
    "forms": "https://yourdomain.com/webhooks/form",
    "retell": "https://yourdomain.com/webhooks/retell"
  },
  "embed_code": "<script>\n  (function() {\n    const clientId = \"550e8400-e29b-41d4-a716-446655440000\";\n    // Load ELYVN chat widget\n    const script = document.createElement('script');\n    script.src = baseUrl + '/elyvn-widget.js';\n    script.dataset.clientId = clientId;\n    document.head.appendChild(script);\n  })();\n</script>",
  "api_endpoints": {
    "get_stats": "/api/stats/550e8400-e29b-41d4-a716-446655440000",
    "get_calls": "/api/calls/550e8400-e29b-41d4-a716-446655440000",
    "get_leads": "/api/leads/550e8400-e29b-41d4-a716-446655440000",
    "get_messages": "/api/messages/550e8400-e29b-41d4-a716-446655440000",
    "get_bookings": "/api/bookings/550e8400-e29b-41d4-a716-446655440000",
    "update_client": "/api/clients/550e8400-e29b-41d4-a716-446655440000"
  },
  "client_details": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "business_name": "Smith Plumbing Services",
    "owner_name": "John Smith",
    "owner_email": "john@smithsplumbing.com",
    "industry": "Plumbing",
    "services": [
      "Emergency repairs",
      "Drain cleaning",
      "Water heater replacement",
      "Fixture installation"
    ],
    "created_at": "2026-03-24T19:03:00.000Z"
  }
}
```

### Error Responses

#### 400 Bad Request (Validation Error)

```json
{
  "success": false,
  "error": "Validation failed",
  "details": [
    "business_name is required and must be a non-empty string",
    "owner_email is required and must be a valid email address"
  ]
}
```

#### 400 Bad Request (Invalid Optional Field)

```json
{
  "success": false,
  "error": "avg_ticket must be a non-negative number"
}
```

#### 500 Internal Server Error

```json
{
  "success": false,
  "error": "Onboarding failed",
  "details": "Database connection error (in development mode only)"
}
```

## What Happens During Onboarding

1. **Validation**: All required fields validated, email format checked
2. **Sanitization**: Input strings sanitized (max 500 chars each)
3. **Client ID Generation**: UUID generated for the new client
4. **Knowledge Base Creation**: JSON file generated at `server/mcp/knowledge_bases/{client_id}.json`
   - Contains business name, greeting, services, hours, FAQ, escalation phrases
   - Used by Claude/Retell for context-aware responses
5. **Database Insert**: Client record created in `clients` table
   - Marked as `is_active = 1`
   - Stores kb_path for later reference
6. **Response Generation**: Returns client_id, webhook URLs, embed code, and next steps

## Knowledge Base Structure

The auto-generated KB JSON has this structure:

```json
{
  "client_id": "550e8400-e29b-41d4-a716-446655440000",
  "business_name": "Smith Plumbing Services",
  "greeting": "Thank you for calling Smith Plumbing Services! How can I help you today?",
  "services": [
    "Emergency repairs",
    "Drain cleaning",
    "Water heater replacement",
    "Fixture installation"
  ],
  "industry": "Plumbing",
  "business_hours": "Mon-Fri 8am-6pm, Sat 9am-2pm",
  "booking_info": "Schedule a service: https://calendly.com/john-smith",
  "faq": [
    {
      "question": "Do you offer emergency service?",
      "answer": "Yes, we have 24/7 emergency service. Call our emergency line."
    }
  ],
  "escalation_phrases": [
    "speak to a person",
    "talk to someone",
    "manager",
    "complaint",
    "human",
    "representative"
  ],
  "generated_at": "2026-03-24T19:03:00.000Z"
}
```

## Integration Steps After Onboarding

### 1. Retell AI Voice Agent

1. Visit https://retell.ai
2. Create a new agent
3. Upload the knowledge base JSON from the onboarding response
4. Configure voice characteristics
5. Get your `retell_agent_id`
6. Update client via: `PUT /api/clients/{client_id}` with `retell_agent_id`

### 2. Twilio Integration

1. Get your Twilio phone number
2. Update client via: `PUT /api/clients/{client_id}` with `twilio_phone`
3. Set webhook URL: `https://yourdomain.com/webhooks/twilio`
4. Test with SMS and voice calls

### 3. Telegram Bot

1. Create bot on Telegram
2. Get bot token
3. Set webhook: `https://yourdomain.com/webhooks/telegram?token={bot_token}`
4. Start receiving messages

### 4. Calendar Integration (Cal.com)

1. Create event type in Cal.com
2. Update client via: `PUT /api/clients/{client_id}` with `calcom_event_type_id` and `calcom_booking_link`
3. AI will offer booking link to callers

### 5. Website Embed

Add the provided `embed_code` to your website's `<head>` section. This loads the ELYVN chat widget.

## Rate Limiting

The onboarding endpoint respects the platform's global rate limit:
- 120 requests per minute per IP address
- Returns 429 Too Many Requests if exceeded

## Input Validation Rules

- **String fields**: Max 500 characters, trimmed of whitespace
- **Email**: Must match standard email pattern (name@domain.com)
- **Array fields**: Must be non-empty, all items must be strings
- **Numbers**: Must be non-negative
- **FAQ items**: Must have both "question" and "answer" fields

## Error Handling

- All errors return appropriate HTTP status codes (400, 500)
- Validation errors include detailed `details` array
- In production, sensitive error details are omitted
- In development, full error messages provided for debugging

## Database Schema

The following fields are stored in the `clients` table:

| Field | Type | Populated |
|-------|------|-----------|
| id | TEXT (UUID) | Yes - auto-generated |
| business_name | TEXT | Yes - from request |
| owner_name | TEXT | Yes - from request |
| owner_phone | TEXT | Yes - from request |
| owner_email | TEXT | Yes - from request |
| industry | TEXT | Yes - from request |
| avg_ticket | REAL | Yes - from request or 0 |
| kb_path | TEXT | Yes - auto-generated |
| timezone | TEXT | Yes - defaults to America/New_York |
| is_active | INTEGER | Yes - defaults to 1 |
| created_at | TEXT | Yes - current timestamp |
| updated_at | TEXT | Yes - current timestamp |

Other fields (retell_agent_id, twilio_phone, etc.) are added later via PUT /api/clients/{client_id}.
