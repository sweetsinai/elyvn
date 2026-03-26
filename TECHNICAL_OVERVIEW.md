# ELYVN Platform - Technical Overview

## Architecture Summary

ELYVN is a full-stack conversational AI platform for business automation, featuring:
- **Backend**: Express.js server with SQLite database
- **Frontend**: React dashboard for admin operations
- **Client Interface**: Telegram bot for real-time business metrics and control
- **Integration Points**: Retell AI (voice), Twilio (SMS/voice), Cal.com (bookings), form webhooks

The system uses WebSocket for real-time updates, job queues for async processing, and AI-driven lead intelligence for conversion optimization.

---

## Server Infrastructure

### Main Server Setup (`server/bridge/index.js`)

**Port**: 3001 (configurable via `PORT` env var)

**Core Services**:
- Database: SQLite via better-sqlite3
- CORS: Configurable origins (defaults to Railway production domain or open in dev)
- Rate Limiting: In-memory per-IP, 120 requests/60s, max 10k entries with LRU eviction
- WebSocket: Real-time updates for dashboard
- Background Jobs: Job queue processor (15s intervals), data retention (24h), auto-classify replies (5m)
- Monitoring: Sentry integration via `initMonitoring()`
- Graceful Shutdown: Cleanup handlers for all timers and connections

**Authentication**:
```javascript
// Timing-safe API key comparison (prevents timing attacks)
safeCompare(a, b) // crypto.timingSafeEqual for global admin key

// Per-client API keys: hashed in database, checked against client_api_keys table
// Supports granular permissions: ["read", "write"] via JSON
```

**Middleware Stack**:
1. CORS with origin whitelist
2. Request correlation IDs for tracing
3. JSON body parser (10MB limit)
4. Rate limiter (per-IP)
5. Auth check (skip webhooks, health, public routes)
6. Client isolation enforcement

**Environment Variables**:
- `ELYVN_API_KEY`: Global admin key (required for production)
- `ANTHROPIC_API_KEY`: Required for AI features
- `RETELL_API_KEY`: For voice agent calls
- `TWILIO_*`: Account SID, auth token, phone number
- `TELEGRAM_BOT_TOKEN`: Telegram bot integration
- `CALCOM_API_KEY`: Calendar integration
- `CORS_ORIGINS`: Comma-separated allowed origins
- `RAILWAY_PUBLIC_DOMAIN`: Auto-set for Railway deployments

---

## Dashboard API Endpoints

All endpoints require `x-api-key` header (except health, landing, demo routes).

### Client Management

**GET /api/clients**
- Fetch all clients (100 limit, newest first)
- Returns: `{ clients: [...] }`

**POST /api/clients**
- Create new client
- Body: `business_name` (req), `owner_name`, `owner_phone`, `owner_email`, `retell_agent_id`, `retell_phone`, `twilio_phone`, `industry`, `timezone`, `calcom_event_type_id`, `calcom_booking_link`, `avg_ticket`, `knowledge_base`
- Returns: `{ client: {...} }`
- Also saves KB JSON to `/server/mcp/knowledge_bases/{clientId}.json`

**PUT /api/clients/:clientId**
- Update client fields (whitelist enforced to prevent injection)
- Allowed fields: `business_name`, `business_address`, `phone`, `email`, `website`, `google_review_link`, `ticket_price`, `timezone`, `ai_enabled`, `booking_link`, `industry`, `auto_followup_enabled`, `owner_name`, `owner_phone`, `owner_email`, `retell_agent_id`, `retell_phone`, `twilio_phone`, `calcom_event_type_id`, `calcom_booking_link`, `telegram_chat_id`, `avg_ticket`, `is_active`
- Also updates KB if `knowledge_base` field provided
- Returns: `{ client: {...} }`

### Core Data Retrieval

**GET /api/stats/:clientId**
- Week-over-week analytics
- Returns:
  - `calls_this_week`, `calls_last_week`, `calls_trend` (% change)
  - `messages_this_week`, `messages_last_week`, `messages_trend`
  - `bookings_this_week`, `estimated_revenue` (booked * avg_ticket)
  - `leads_by_stage` (new, contacted, qualified, booked, completed, lost)

**GET /api/calls/:clientId**
- Fetch calls with filtering and pagination
- Query params: `outcome`, `startDate`, `endDate`, `minScore`, `page`, `limit`
- Returns: `{ calls: [...], total, page, limit, total_pages }`
- Fields: `id`, `call_id`, `caller_phone`, `direction`, `duration`, `outcome`, `summary`, `score`, `sentiment`, `created_at`

**GET /api/calls/:clientId/:callId/transcript**
- Fetch full transcript from Retell API
- Returns: `{ transcript: [...] }`

**GET /api/messages/:clientId**
- Fetch SMS/messages
- Query params: `status` (direction), `startDate`, `endDate`, `page`, `limit`
- Returns: `{ messages: [...], total, page, limit, total_pages }`

**GET /api/leads/:clientId**
- Fetch leads with search and filtering
- Query params: `stage`, `minScore`, `search`, `page`, `limit`
- Returns: `{ leads: [...with recent_calls/recent_messages], total, page, limit, total_pages }`
- Each lead includes last 3 calls and 3 messages (batch-loaded in single query)

**PUT /api/leads/:clientId/:leadId**
- Update lead stage
- Body: `{ stage: 'new'|'contacted'|'qualified'|'booked'|'completed'|'lost' }`
- Returns: `{ success: true, stage }`

**GET /api/bookings/:clientId**
- Fetch Cal.com bookings for client
- Query params: `startDate`, `endDate` (ISO strings)
- Returns: `{ bookings: [...] }` or empty if not configured

**GET /api/reports/:clientId**
- Fetch weekly reports (last 12)
- Returns: `{ reports: [...] }`

### Intelligence & Analytics

**GET /api/intelligence/:clientId**
- Full conversation intelligence report
- Query param: `days` (1-90, default 30)
- Returns: Complex analysis object from `conversationIntelligence` util

**GET /api/intelligence/:clientId/peak-hours**
- Peak activity hours (day/hour breakdown)
- Returns: `{ peak_hours: { data: [{ hour, day, volume }, ...] } }`

**GET /api/intelligence/:clientId/response-impact**
- Response time impact on conversion
- Returns: Analysis object from `conversationIntelligence`

**GET /api/scoring/:clientId**
- Batch lead scores (all active leads)
- Returns: `{ leads: [{id, score, factors}, ...], total }`

**GET /api/scoring/:clientId/:leadId**
- Individual lead predictive score
- Returns: `{ lead_id, score, factors: {engagement, history, timing, ...} }`

**GET /api/scoring/:clientId/analytics/conversion**
- Conversion funnel analytics
- Returns: `{ total_leads, stage_breakdown, conversion_rate, ... }`

**GET /api/revenue/:clientId**
- ROI metrics and revenue attribution
- Query param: `days` (default 30)
- Returns: `{ total_revenue, attributed_to_ai, channel_breakdown, ... }`

**GET /api/revenue/:clientId/:leadId**
- Single lead attribution chain
- Returns: `{ lead_id, touchpoints: [{channel, timestamp, impact}, ...], total_attributed }`

**GET /api/revenue/:clientId/channels/performance**
- Performance by channel (calls, SMS, form, etc.)
- Returns: `{ channels: [{name, leads, conversions, revenue}, ...] }`

### Smart Scheduling

**GET /api/schedule/:clientId**
- AI-generated daily contact schedule
- Returns: `{ schedule: [{lead_id, phone, optimal_time, reason}, ...], total }`

**GET /api/schedule/:clientId/time-slots**
- Optimal time slot analysis
- Returns: `{ slots: [{time, success_rate, volume}, ...] }`

### AI Chat Feature

**POST /api/chat**
- Stream-based Anthropic chat for dashboard AI features
- Body: `{ messages: [{role, content}, ...], clientId }`
- System prompt includes: client KB, business context, recent stats
- Returns: Server-Sent Events stream
  - `{ type: 'text', text: '...' }`
  - `{ type: 'done' }`
  - `{ type: 'error', error: '...' }`

### System Health

**GET /health**
- No auth required
- Returns: `{ status, timestamp, uptime_seconds, memory, services: {db}, database: {...}, db_counts: {...}, env_configured: {...} }`

**GET /metrics**
- Detailed metrics (requires auth)
- Returns internal performance metrics

---

## Telegram Bot Client Interface

**Webhook**: `POST /webhooks/telegram`

**Authentication**: Optional `x-telegram-bot-api-secret-token` header validation

**Linking**: Business owner connects via `/start {clientId}` onboarding link

### Commands

#### **/start** (or /start {clientId})
- Links chat to client account
- Shows welcome message with command list
- Updates `telegram_chat_id` in clients table

#### **/status** (or /start if already linked)
- Full dashboard overview
- Today's stats: calls, messages, booked/missed
- Week stats: calls, bookings, revenue estimate
- Active leads count (hot, booked)
- Last 3 calls with emojis, duration, score
- AI status (🟢 active / 🔴 paused)
- Pending jobs count

#### **/leads**
- All active leads grouped by stage (hot, booked, warm, contacted, new, nurture, lost)
- Sorted by priority (hot first)
- Shows name, score (out of 10), time since update
- Max 20 leads displayed

#### **/calls**
- Last 5 calls with details
- Outcome emoji (✅ booked, ❌ missed, 📩 voicemail, 🔀 transferred, 📞 generic)
- Duration, quality score, summary preview
- Inline keyboard for "Full transcript" callback button

#### **/pause**
- Disables AI (calls ring through to owner)
- Updates `is_active = 0`

#### **/resume**
- Re-enables AI
- Updates `is_active = 1`

#### **/complete +phone**
- Marks job complete for phone number
- Workflow:
  1. Mark all appointments for phone as 'completed'
  2. Cancel reminder followups for associated lead
  3. Update lead stage to 'completed'
  4. Schedule review request message (2h delay)
- Requires Google review link configured
- Returns confirmation with warning if review link not set

#### **/set key value**
- Configure settings:
  - `/set review {url}` — Google review link (URL validation required)
  - `/set ticket {amount}` — Average ticket price (number validation)
  - `/set name {text}` — Business name

#### **/help**
- Shows all available commands

### Callbacks

**Inline Keyboard Buttons**:
- `transcript:{callId}` — Fetch and send call transcript (truncated to 3500 chars)
- `msg_ok:` — Mark AI reply as good
- `msg_takeover:{phone}` — Manual takeover notification
- `cancel_speed:{leadId}` — Cancel speed-to-lead sequence (cancels scheduled jobs)

**Rate Limiting**: Max 10 callbacks/minute per chatId

### Real-time Notifications

The bot sends proactive messages for:
- New form submissions (no phone number alert)
- New incoming calls
- New leads/bookings
- System alerts

---

## Form Webhook Integration

**Endpoint**: `POST /webhooks/form` (client_id in body) or `POST /webhooks/form/:clientId`

**Accepts**: JSON or URL-encoded form data

**Field Aliases** (normalized from various form builders):
- **Name**: `name`, `first_name`, `your-name`, `fullName`, `full_name`
- **Phone**: `phone`, `Phone`, `your-phone`, `tel`, `telephone`, `mobile`, `cell`, `phone_number`
- **Email**: `email`, `Email`, `your-email`, `email_address`, `emailAddress`
- **Message**: `message`, `Message`, `your-message`, `comments`, `inquiry`, `details`, `notes`
- **Service**: `service`, `Service`, `service_type`, `serviceType`, `service-type`
- **Source**: `utm_source`, `source`, `referrer` (default: `website_form`)

### Processing Flow

1. **Validation**: Phone normalized via `normalizePhone()`, email/phone format validated
2. **Deduplication**: 5-minute window prevents duplicate speed-to-lead for same phone+email
3. **Database**: INSERT ... ON CONFLICT for atomic upsert (handles race conditions)
4. **Lead Creation**: Scored at 7 (new = 5), stage = 'new'
5. **Message Logging**: Inbound message recorded with form source
6. **Speed Sequence**: Triggers 3-touch speed-to-lead (call, SMS, email)
7. **Brain Decision**: AI thinking to determine next actions based on memory
8. **Telegram Alert**: Notifies client of new submission (if email-only, alerts on missing phone)

**Rate Limiting**: 10 submissions per 60 seconds per IP

**Response**: Always 200 immediately (for form builder compatibility)

---

## Client Onboarding

**Endpoint**: `POST /api/onboard`

**Rate Limit**: 5 requests/minute per IP

### Required Fields
- `business_name` (string, non-empty)
- `owner_name` (string)
- `owner_phone` (valid phone)
- `owner_email` (valid email)
- `industry` (string)
- `services` (array of strings, non-empty)

### Optional Fields
- `business_hours` (string, e.g., "Mon-Fri 8am-6pm")
- `avg_ticket` (number >= 0)
- `booking_link` (valid URL)
- `faq` (array of `{question, answer}` objects)

### Response

```json
{
  "success": true,
  "client_id": "uuid",
  "status": "active",
  "kb_generated": true,
  "kb_path": "server/mcp/knowledge_bases/{clientId}.json",
  "next_steps": [
    "1. Connect Retell AI voice agent...",
    "2. Configure Twilio...",
    // ... 6 total steps
  ],
  "webhook_urls": {
    "twilio": "https://...",
    "telegram": "https://...",
    "forms": "https://...",
    "retell": "https://..."
  },
  "embed_code": "<script>...</script>",
  "api_endpoints": {
    "get_stats": "/api/stats/{clientId}",
    "get_calls": "/api/calls/{clientId}",
    // ...
  },
  "client_details": {
    "id": "uuid",
    "business_name": "...",
    "services": [...]
  }
}
```

### Automatic Outputs

- **Knowledge Base JSON**: Generated with:
  - Business description
  - Service list
  - Industry, hours, booking info
  - FAQ items
  - Escalation phrases (speaker to person, manager, complaint, human, representative)
  - Generated timestamp

- **Embed Code**: HTML snippet for website integration (loads `elyvn-widget.js`)

---

## Admin Dashboard (`dashboard/`)

**Tech Stack**: React 18 + Vite, Lucide icons, WebSocket

**Authentication**: Session-stored API key via login gate component

### Pages

#### Dashboard (`/`)
- Client selector dropdown
- Key metrics cards:
  - 📞 Calls (this week vs trend)
  - 💬 Messages (this week vs trend)
  - ✅ Bookings (this week)
  - 💰 Revenue estimate
  - Lead pipeline by stage
- Recent activity feed (calls + messages, 10 items)
- Real-time WebSocket updates

#### Pipeline (`/pipeline`)
- Kanban-style lead management
- Columns: New, Contacted, Qualified, Booked, Completed, Lost
- Drag-and-drop stage transitions (optimistic updates)
- Lead detail panel:
  - Score (0-10)
  - Contact history (calls + messages)
  - Recent interactions
- Search leads by name/phone/email
- Filter by stage
- Pagination (20 leads/page)
- WebSocket integration for real-time updates

#### Calls (`/calls`)
- Paginated call history
- Filter by outcome (booked, missed, voicemail, transferred)
- Transcript viewer
- Quality scores and duration
- Caller info

#### Messages (`/messages`)
- SMS/message history
- Direction filter (inbound/outbound)
- Search by content
- Pagination

#### Intelligence (`/intelligence`)
- Conversation intelligence report
- Peak hours heatmap (8AM-8PM, Mon-Fri)
- Response time impact on conversion
- **Lead Scoring**: Predictive scores with factors
- **Conversion Analytics**: Funnel breakdown
- **Revenue Attribution**: ROI, channel performance
- **Daily Schedule**: AI-generated contact recommendations
- Selectable time range (1-90 days)
- Real-time refresh (60s intervals)

#### Outreach (`/outreach`)
- Business scraping tool
- Campaign management
- Email generation and sending
- Reply classification
- List management

#### Settings (`/settings`)
- Client CRUD operations
- API configuration
- Integration statuses (Retell, Twilio, Cal.com, Telegram)
- Knowledge base editor (JSON)
- System health check
- Webhook URLs reference

### API Library (`src/lib/api.js`)

All functions auto-inject `x-api-key` header from sessionStorage.

**Export Functions**:
- `getHealth()` — No auth
- `getStats(clientId)`, `getCalls(clientId, params)`, `getTranscript(clientId, callId)`
- `getMessages(clientId, params)`, `getLeads(clientId, params)`, `updateLeadStage(clientId, leadId, stage)`
- `getBookings(clientId, startDate, endDate)`
- `getCampaigns()`, `createCampaign(data)`, `generateEmails(campaignId)`, `sendCampaign(campaignId)`
- `getReplies()`, `classifyReply(emailId)`, `scrapeBusinesses(data)`
- `getClients()`, `createClient(data)`, `updateClient(clientId, data)`
- `getIntelligence(clientId, days)`, `getPeakHours(clientId)`, `getResponseImpact(clientId)`
- `getLeadScores(clientId)`, `getConversionAnalytics(clientId)`
- `getRevenue(clientId, days)`, `getChannelPerformance(clientId)`
- `getDailySchedule(clientId)`

### WebSocket (`src/lib/useWebSocket.js`)

- Connects to `/api/ws` with API key auth
- Listens for events: `new_call`, `new_message`, `new_lead`, `lead_updated`, `call_updated`
- Triggers automatic data refresh in Pipeline page
- Maintains connection state

### Components

- **LoginGate**: Session auth check, redirects to login if no key
- **Sidebar**: Navigation, client selector, status indicator
- **StatsCard**: Metric display with trends
- **StatusBadge**: Outcome/stage badges with colors
- **LeadCard**: Compact lead display in Kanban
- **CallCard**: Call details display
- **MessageCard**: Message bubble display
- **LoadingSkeleton**: Placeholder loading state
- **ErrorBoundary**: Crash recovery

---

## Database Schema

### Core Tables

**clients**
- `id` (UUID, PK)
- `business_name`, `business_address`, `phone`, `email`, `website`
- `google_review_link`, `ticket_price`, `timezone`
- `ai_enabled`, `booking_link`, `industry`, `auto_followup_enabled`
- `owner_name`, `owner_phone`, `owner_email`
- `retell_agent_id`, `retell_phone`, `twilio_phone`
- `calcom_event_type_id`, `calcom_booking_link`, `telegram_chat_id`
- `avg_ticket`, `is_active`, `created_at`, `updated_at`

**calls**
- `id`, `call_id`, `client_id`, `caller_phone`, `caller_name`
- `direction`, `duration`, `outcome`, `summary`, `score`, `sentiment`, `transcript`
- `created_at`, `updated_at`

**messages**
- `id`, `client_id`, `lead_id`, `phone`, `channel` (form, sms, email)
- `direction` (inbound/outbound), `body`, `status` (received, sent, failed)
- `created_at`, `updated_at`

**leads**
- `id`, `client_id`, `phone`, `name`, `email`, `source`, `score`, `stage`
- `last_contact`, `created_at`, `updated_at`

**job_queue**
- `id`, `client_id`, `type` (sms, email, call, etc.), `payload` (JSON)
- `status` (pending, processing, done, failed), `attempts`, `next_retry_at`
- `error`, `created_at`

**followups**
- `id`, `lead_id`, `client_id`, `touch_number`, `type` (reminder, email, sms, review_request)
- `content`, `content_source` (template, ai, user), `scheduled_at`, `status`

**appointments**
- `id`, `client_id`, `lead_id`, `phone`, `service`, `datetime`
- `status` (pending, confirmed, completed, cancelled), `created_at`

**weekly_reports**
- `id`, `client_id`, `week_start`, `total_calls`, `booked`, `revenue`
- `top_performers`, `created_at`

**client_api_keys**
- `id`, `client_id`, `api_key_hash`, `permissions` (JSON)
- `is_active`, `expires_at`, `created_at`, `last_used_at`

**emails_sent**
- `id`, `campaign_id`, `recipient_email`, `subject`, `body_html`
- `status` (sent, bounced, opened, clicked), `reply_text`, `reply_classification`
- `created_at`

**campaigns**
- `id`, `client_id`, `name`, `target_industry`, `target_job_title`
- `subject_line`, `body_template`, `status` (draft, generating, ready, sending, sent)
- `created_at`, `sent_at`

---

## Key Integrations

### Retell AI (Voice Calls)
- **API Base**: https://api.retellai.com/v2/
- **Endpoints Used**:
  - `POST /create-phone-number` — Allocate voice number
  - `POST /create-agent` — Create conversational agent
  - `POST /set-phone-number` — Link agent to number
  - `GET /get-call/{callId}` — Fetch call transcript and metadata
- **Webhooks**: `/webhooks/retell` receives call completion events (call_id, transcript, duration, outcome)

### Twilio (SMS/Voice)
- **Account Setup**: SID, auth token, phone number
- **Webhooks**: `/webhooks/twilio` receives SMS/call status updates
- **Integration**: Speed-to-lead triggers SMS via job queue

### Cal.com (Scheduling)
- **Integration**: `calcom_event_type_id`, `calcom_booking_link` in clients
- **API**: Fetches bookings to show in dashboard
- **Webhooks**: `/webhooks/calcom` receives booking created/cancelled/rescheduled events

### Telegram Bot
- **Token**: Environment variable `TELEGRAM_BOT_TOKEN`
- **Webhook URL**: Auto-set on server startup
- **Features**: Commands, callbacks, real-time notifications

---

## Security & Best Practices

### Authentication
- **Timing-safe comparison** for API key validation (prevents timing attacks)
- **Per-client API keys** with optional expiration and granular permissions
- **Session-stored keys** in dashboard (no local storage to prevent XSS leakage)

### Input Validation
- **Phone**: Format validation via libphonenumber-js equivalent
- **Email**: RFC5321 regex validation
- **UUID**: UUID format enforcement
- **SQL Injection**: Parameterized queries throughout, whitelist for dynamic fields
- **URL Validation**: HTTPS required for integration URLs

### Data Protection
- **Knowledge bases**: Stored in `/server/mcp/knowledge_bases/` (not in DB for scalability)
- **Sensitive fields**: Hashed API keys, no plaintext storage
- **Rate limiting**: Per-IP, per-callback to prevent abuse
- **Deduplication**: Speed-to-lead 5m window prevents spam

### Error Handling
- **Comprehensive logging** with correlation IDs
- **Graceful degradation**: Features disable if dependencies unavailable
- **Global error handlers**: Catch unhandled rejections and exceptions
- **Monitoring integration**: Sentry for production error tracking

---

## Performance Optimizations

1. **Batch Loading**: Leads load recent calls/messages in single query per table
2. **Pagination**: 20-100 items per page, total counts cached
3. **Rate Limiting**: LRU eviction prevents memory bloat
4. **Database Indexing**: Client + phone uniqueness, status queries optimized
5. **Job Queue**: Async processing for long-running tasks (calls, emails, SMS)
6. **Data Retention**: Automatic cleanup of old records (configurable window)
7. **WebSocket**: Real-time updates without polling
8. **Caching**: Intelligence reports cached for 5m intervals
9. **Streaming**: Chat endpoint uses Server-Sent Events for progressive responses
10. **Compression**: Gzip for API responses

---

## Deployment Notes

### Production Requirements
- Set `ELYVN_API_KEY` for admin security
- Configure `CORS_ORIGINS` (comma-separated list)
- Set `TELEGRAM_BOT_TOKEN` for bot features
- Provide `RETELL_API_KEY`, `TWILIO_*` credentials
- Use `NODE_ENV=production`
- Configure Railway domain or set `BASE_URL`

### Database Backups
- Automatic daily backups (configurable interval)
- WAL checkpoint on each backup
- Retention policy enforced

### Monitoring
- Health check at `/health` (no auth)
- Metrics at `/metrics` (requires auth)
- Graceful shutdown cleanup
- Unhandled rejection/exception capture

---

## File Structure

```
server/bridge/
├── index.js                 # Main Express server
├── routes/
│   ├── api.js              # All dashboard endpoints
│   ├── telegram.js         # Telegram bot commands & callbacks
│   ├── forms.js            # Form submission webhooks
│   ├── onboard.js          # Client onboarding
│   ├── retell.js           # Retell voice webhook
│   ├── twilio.js           # Twilio SMS/call webhook
│   ├── campaigns.js        # Email campaign routes
│   ├── email-send.js       # Email sending
│   ├── replies.js          # Reply classification
│   └── tracking.js         # Email open/click tracking
├── utils/
│   ├── config.js           # Configuration
│   ├── logger.js           # File-based logging
│   ├── dbAdapter.js        # SQLite connection
│   ├── authLog.js          # Audit logging
│   ├── rateLimiter.js      # Token bucket limiter
│   ├── telegram.js         # Telegram API wrapper
│   ├── jobQueue.js         # Job processing
│   ├── speed-to-lead.js    # Triple-touch sequences
│   ├── conversationIntelligence.js  # Analytics
│   ├── leadScoring.js      # Predictive scoring
│   ├── revenueAttribution.js        # ROI tracking
│   ├── smartScheduler.js   # AI scheduling
│   ├── brain.js            # Decision engine
│   ├── actionExecutor.js   # Action workflows
│   └── websocket.js        # Real-time updates
└── public/                 # Built dashboard (production)

dashboard/
├── src/
│   ├── pages/
│   │   ├── Dashboard.jsx   # Overview
│   │   ├── Pipeline.jsx    # Lead Kanban
│   │   ├── Calls.jsx       # Call history
│   │   ├── Messages.jsx    # SMS history
│   │   ├── Intelligence.jsx # Analytics
│   │   ├── Outreach.jsx    # Campaigns
│   │   └── Settings.jsx    # Configuration
│   ├── components/         # Reusable UI
│   ├── lib/
│   │   ├── api.js         # API client
│   │   ├── useWebSocket.js # WS hook
│   │   └── utils.js       # Helpers
│   └── App.jsx            # Router
└── public/
    └── index.html         # SPA root
```

---

## Common Workflows

### Onboarding New Client
1. Client visits onboarding page
2. POST `/api/onboard` with business details
3. Server creates client record, generates KB, returns URLs
4. Client integrates Retell voice agent, Twilio SMS, Telegram bot
5. Client embeds form widget on website
6. System ready for live traffic

### Capturing Lead from Form
1. Form submission → POST `/webhooks/form/{clientId}`
2. Lead upserted to database (phone as unique key)
3. Message logged for audit
4. Speed-to-lead job queued (call + SMS + email)
5. Telegram notification sent to owner
6. AI brain processes and decides next actions

### Owner Viewing Business on Telegram
1. Owner runs `/status` command
2. Bot queries today + week stats from database
3. Shows active leads, recent calls, revenue estimate
4. Owner can `/pause` AI, `/complete` jobs, `/set` config
5. Callbacks handle transcript, takeover, and cancellation

### Admin Reviewing Dashboard
1. Admin logs in with API key
2. Selects client from dropdown
3. Views stats, lead pipeline, call history
4. Drags leads between stages (updates DB)
5. Clicks lead for interaction history
6. Views intelligence reports (peak hours, lead scores, ROI)
7. Configures client settings and knowledge base

---

## Future Enhancement Points

- **Multi-language support** for bot commands and AI responses
- **Advanced filtering** in dashboard (date ranges, custom queries)
- **Bulk actions** on leads (stage update, email campaigns)
- **Custom workflows** builder for complex automations
- **API rate limit dashboard** for per-client monitoring
- **Export/import** for leads, campaigns, call transcripts
- **SMS auto-reply** templates based on intent
- **Call recording integration** with Retell
- **Twilio voice callback** for better UX
- **Custom emojis** per client for branding

---

**Last Updated**: 2026-03-26
**Version**: 1.0 (Production Ready)
