# Onboarding API - Quick Start Guide

## What Was Built

A single REST endpoint that handles complete client onboarding for the ELYVN platform in one atomic call.

**Endpoint:** `POST /api/onboard`

## Key Files

| File | Purpose |
|------|---------|
| `server/bridge/routes/onboard.js` | Main endpoint implementation |
| `server/bridge/index.js` | Updated to mount the route |
| `ONBOARDING_API.md` | Complete API documentation |
| `test-onboard.js` | Test suite with 6 test cases |
| `IMPLEMENTATION_SUMMARY.md` | Technical implementation details |

## Quick Example

```bash
curl -X POST http://localhost:3001/api/onboard \
  -H "Content-Type: application/json" \
  -d '{
    "business_name": "Smith Plumbing",
    "owner_name": "John Smith",
    "owner_phone": "+1-555-123-4567",
    "owner_email": "john@smithplumbing.com",
    "industry": "Plumbing",
    "services": ["Emergency repairs", "Installation"],
    "business_hours": "Mon-Fri 8am-6pm, Sat 9am-2pm",
    "avg_ticket": 150,
    "booking_link": "https://calendly.com/john",
    "faq": [
      {
        "question": "Do you offer emergency service?",
        "answer": "Yes, 24/7 emergency service available"
      }
    ]
  }'
```

## Response (201 Created)

```json
{
  "success": true,
  "client_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "active",
  "kb_generated": true,
  "kb_path": "server/mcp/knowledge_bases/550e8400-e29b-41d4-a716-446655440000.json",
  "next_steps": [
    "1. Connect Retell AI voice agent",
    "2. Configure Twilio phone number",
    "3. Set up Telegram bot",
    ...
  ],
  "webhook_urls": {
    "twilio": "https://yourdomain.com/webhooks/twilio",
    "telegram": "https://yourdomain.com/webhooks/telegram",
    "forms": "https://yourdomain.com/webhooks/form",
    "retell": "https://yourdomain.com/webhooks/retell"
  },
  "embed_code": "<script>...</script>",
  "api_endpoints": {
    "get_stats": "/api/stats/550e8400-e29b-41d4-a716-446655440000",
    "get_calls": "/api/calls/550e8400-e29b-41d4-a716-446655440000",
    ...
  },
  "client_details": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "business_name": "Smith Plumbing",
    "owner_name": "John Smith",
    "owner_email": "john@smithplumbing.com",
    "industry": "Plumbing",
    "services": ["Emergency repairs", "Installation"],
    "created_at": "2026-03-24T19:03:00.000Z"
  }
}
```

## Required Fields

| Field | Type | Example |
|-------|------|---------|
| `business_name` | string | "Smith Plumbing Services" |
| `owner_name` | string | "John Smith" |
| `owner_phone` | string | "+1-555-123-4567" |
| `owner_email` | string | "john@smithplumbing.com" |
| `industry` | string | "Plumbing" |
| `services` | string[] | ["Repairs", "Installation"] |

## Optional Fields

| Field | Type | Example |
|-------|------|---------|
| `business_hours` | string | "Mon-Fri 8am-6pm, Sat 9am-2pm" |
| `avg_ticket` | number | 150 |
| `booking_link` | string | "https://calendly.com/john" |
| `faq` | object[] | [{question: "...", answer: "..."}] |

## What Happens

1. ✓ Validates all inputs
2. ✓ Generates unique client ID (UUID)
3. ✓ Creates knowledge base JSON file
4. ✓ Inserts client into database
5. ✓ Returns webhook URLs and embed code
6. ✓ Provides next integration steps

## What Gets Created

### Database Record
Client record in `clients` table with:
- Unique ID (UUID)
- Business details
- Owner contact info
- Path to knowledge base file
- Active status

### Knowledge Base File
`server/mcp/knowledge_bases/{client_id}.json` with:
- Business name and greeting
- Services list
- Business hours
- FAQ items
- Escalation phrases for support routing
- Generated timestamp

## Test the API

```bash
# Run test suite
node test-onboard.js

# Tests 6 scenarios:
# 1. Valid onboarding (should pass)
# 2. Missing business_name (should fail)
# 3. Invalid email (should fail)
# 4. Empty services array (should fail)
# 5. Negative avg_ticket (should fail)
# 6. Minimal payload with only required fields (should pass)
```

## Status Codes

| Code | Meaning |
|------|---------|
| 201 | Client created successfully |
| 400 | Validation error (missing/invalid fields) |
| 500 | Server error (database/file system issue) |

## Error Examples

### Missing Required Field
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

### Invalid Optional Field
```json
{
  "success": false,
  "error": "avg_ticket must be a non-negative number"
}
```

## Integration Steps After Onboarding

1. **Retell AI** - Create voice agent with knowledge base
2. **Twilio** - Add phone number, set webhook
3. **Telegram** - Configure bot webhook
4. **Cal.com** - Link booking system
5. **Website** - Add embed code snippet
6. **Test** - Make test calls and SMS

## Validation Rules

- All strings: max 500 characters
- Email: standard format (name@domain.com)
- Services: non-empty array of non-empty strings
- avg_ticket: non-negative number
- FAQ: each item must have question and answer
- No SQL injection (parameterized queries)
- No XSS (sanitized input)

## Authentication

**Public endpoint** - No API key required

Clients can self-register. The existing `/api` routes with API key requirement follow this endpoint in the route stack.

## Database

**Table:** `clients`

New fields populated:
- id (UUID)
- business_name
- owner_name
- owner_phone
- owner_email
- industry
- avg_ticket
- kb_path
- timezone (defaults to America/New_York)
- is_active (defaults to 1)
- created_at
- updated_at

Other fields added later via PUT endpoint.

## Code Patterns

The implementation follows existing ELYVN patterns:

✓ Express Router pattern
✓ better-sqlite3 for database
✓ UUID from crypto module
✓ Async file operations (fsPromises)
✓ Try/catch error handling
✓ Logging to console
✓ JSDoc comments

## Documentation

- **API Docs:** `ONBOARDING_API.md` - Complete reference
- **Implementation:** `IMPLEMENTATION_SUMMARY.md` - Technical details
- **Tests:** `test-onboard.js` - Runnable test suite
- **This File:** Quick reference

## Next Steps

1. Review `ONBOARDING_API.md` for complete API documentation
2. Run `test-onboard.js` to verify the endpoint works
3. Integrate with your client onboarding flow
4. Implement post-onboarding steps (Retell, Twilio, Telegram)
5. Monitor logs for any issues

## Support

For issues or questions:
1. Check `ONBOARDING_API.md` for detailed documentation
2. Review `IMPLEMENTATION_SUMMARY.md` for technical details
3. Run tests: `node test-onboard.js`
4. Check server logs for errors

---

**Ready to onboard your first client? Run:**
```bash
node test-onboard.js
```
