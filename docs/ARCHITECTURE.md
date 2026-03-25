# ELYVN Bridge Architecture Documentation

System design, component responsibilities, data flows, and technology choices for the ELYVN AI receptionist bridge server.

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Component Architecture](#component-architecture)
3. [Data Flow](#data-flow)
4. [Technology Stack](#technology-stack)
5. [Security Model](#security-model)
6. [Scaling & Performance](#scaling--performance)
7. [Design Decisions](#design-decisions)

---

## System Overview

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        External Services                        │
├─────────────────────────────────────────────────────────────────┤
│  Retell AI    Twilio    Cal.com    Telegram    Google Places   │
│  (Voice AI)   (SMS)    (Bookings)  (Chat Bot)   (Lead Scraping) │
└────┬─────────┬──────────┬──────────┬──────────────────────────┘
     │         │          │          │
     │ Webhooks│ Webhooks │ Webhooks │ Webhooks
     │         │          │          │
┌────▼─────────▼──────────▼──────────▼──────────────────────────┐
│                   ELYVN Bridge Server                          │
│                    (Express.js Node.js)                        │
├────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────┐  │
│  │              Request Middleware Stack                   │  │
│  │  Correlation ID → CORS → Rate Limit → Auth → Routes    │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                                │
│  ┌────────────────────────────────────────────────────────┐   │
│  │              Route Handlers                            │   │
│  │  ┌──────────────────────────────────────────────────┐  │   │
│  │  │ Webhooks (no auth)                               │  │   │
│  │  │ - /webhooks/retell    (call events)              │  │   │
│  │  │ - /webhooks/twilio    (SMS in)                   │  │   │
│  │  │ - /webhooks/form      (lead captures)            │  │   │
│  │  │ - /webhooks/calcom    (bookings)                 │  │   │
│  │  │ - /webhooks/telegram  (bot messages)             │  │   │
│  │  └──────────────────────────────────────────────────┘  │   │
│  │  ┌──────────────────────────────────────────────────┐  │   │
│  │  │ API Routes (auth required)                       │  │   │
│  │  │ - /api/stats          (metrics & stats)          │  │   │
│  │  │ - /api/calls          (call history)             │  │   │
│  │  │ - /api/leads          (lead management)          │  │   │
│  │  │ - /api/messages       (SMS/Telegram history)     │  │   │
│  │  │ - /api/bookings       (Cal.com integration)      │  │   │
│  │  │ - /api/clients        (client CRUD)              │  │   │
│  │  │ - /api/outreach       (email campaigns)          │  │   │
│  │  └──────────────────────────────────────────────────┘  │   │
│  │  ┌──────────────────────────────────────────────────┐  │   │
│  │  │ Public Routes (no auth)                          │  │   │
│  │  │ - /api/onboard        (client signup)            │  │   │
│  │  │ - /health             (health check)             │  │   │
│  │  │ - /t/open             (email tracking pixel)      │  │   │
│  │  │ - /t/click            (email click redirect)      │  │   │
│  │  └──────────────────────────────────────────────────┘  │   │
│  └────────────────────────────────────────────────────────┘   │
│                                                                │
│  ┌────────────────────────────────────────────────────────┐   │
│  │              Core Utilities                           │   │
│  │  ┌──────────────────────────────────────────────────┐ │   │
│  │  │ Database Layer                                   │ │   │
│  │  │ - dbAdapter      (SQLite abstraction)            │ │   │
│  │  │ - migrations     (schema versioning)             │ │   │
│  │  └──────────────────────────────────────────────────┘ │   │
│  │  ┌──────────────────────────────────────────────────┐ │   │
│  │  │ Business Logic                                   │ │   │
│  │  │ - speed-to-lead  (SMS → callback → follow-up)    │ │   │
│  │  │ - brain          (Anthropic API integration)     │ │   │
│  │  │ - leadScoring    (lead qualification)            │ │   │
│  │  │ - conversationIntelligence (sentiment & summary) │ │   │
│  │  └──────────────────────────────────────────────────┘ │   │
│  │  ┌──────────────────────────────────────────────────┐ │   │
│  │  │ Integration Utilities                            │ │   │
│  │  │ - sms            (Twilio SMS sending)             │ │   │
│  │  │ - telegram       (Telegram bot messaging)         │ │   │
│  │  │ - calcom         (Cal.com API client)             │ │   │
│  │  │ - emailSender    (SMTP + templating)              │ │   │
│  │  └──────────────────────────────────────────────────┘ │   │
│  │  ┌──────────────────────────────────────────────────┐ │   │
│  │  │ Infrastructure                                   │ │   │
│  │  │ - jobQueue       (persistent async jobs)         │ │   │
│  │  │ - rateLimiter    (in-memory rate limiting)        │ │   │
│  │  │ - websocket      (real-time dashboard updates)   │ │   │
│  │  │ - backup         (automated daily backups)        │ │   │
│  │  │ - logger         (structured file logging)        │ │   │
│  │  │ - monitoring     (error tracking & metrics)       │ │   │
│  │  └──────────────────────────────────────────────────┘ │   │
│  └────────────────────────────────────────────────────────┘   │
└────────────┬──────────────────────────────────────────────────┘
             │
             │ Reads/Writes
             │
        ┌────▼────────────────────────────────┐
        │      SQLite Database                │
        │   (Better-SQLite3, WAL mode)        │
        ├─────────────────────────────────────┤
        │ Tables:                             │
        │ - clients      (configurations)     │
        │ - calls        (call history)       │
        │ - messages     (SMS/chat history)   │
        │ - leads        (prospect tracking)  │
        │ - job_queue    (async task queue)   │
        │ - emails_sent  (campaign tracking)  │
        │ - appointments (booking records)    │
        │ - audit_logs   (security logs)      │
        └─────────────────────────────────────┘
```

### Request Flow Example: Lead Capture → Callback

```
1. Customer fills form on client's website
   └─→ POST /webhooks/form (with client_id, name, phone)

2. Bridge validates and creates lead record in DB
   └─→ INSERT INTO leads (...)
   └─→ INSERT INTO calls (direction='outbound', outcome='speed_callback')

3. Speed-to-lead sequence triggered
   ├─→ TOUCH 1: Enqueue SMS job (immediate)
   │   └─→ INSERT INTO job_queue (type='speed_to_lead_sms', scheduled_at=now)
   │
   ├─→ TOUCH 2: Schedule callback (60 seconds)
   │   └─→ INSERT INTO job_queue (type='speed_to_lead_callback', scheduled_at=now+60s)
   │
   └─→ TOUCH 3: Schedule follow-up SMS (5 minutes)
       └─→ INSERT INTO job_queue (type='speed_to_lead_sms', scheduled_at=now+5m)

4. Job processor (every 15s) executes due jobs
   ├─→ speed_to_lead_sms:     Calls Twilio API to send SMS
   ├─→ speed_to_lead_callback: Calls Retell API to create outbound call
   └─→ Response updates job_queue (status='completed')

5. Retell AI calls customer
   └─→ AI agent answers, qualifies lead, books appointment if interested

6. Retell sends webhook: call_analyzed
   ├─→ Bridge stores: call record (summary, sentiment, booking status)
   ├─→ Updates lead: stage, score, outcome
   └─→ Cancels pending jobs if booking confirmed

7. Cal.com webhook (if booked)
   ├─→ Bridge receives: BOOKING_CREATED event
   ├─→ Updates lead: stage='booked'
   ├─→ Sends confirmation SMS to customer
   └─→ Notifies owner via Telegram
```

---

## Component Architecture

### Core Layers

#### 1. Presentation Layer (Express.js Routes)
- **Responsibility**: Handle HTTP requests, validate inputs, format responses
- **Files**: `routes/*.js`
- **Key Operations**:
  - Parse and validate webhook payloads (Retell, Twilio, Cal.com, Telegram)
  - Authenticate API requests (API key validation)
  - Enforce rate limiting
  - Route requests to business logic
  - Format and return JSON responses

#### 2. Business Logic Layer
- **Responsibility**: Core application logic, decision-making, orchestration
- **Key Components**:

**Speed-to-Lead (`utils/speed-to-lead.js`)**
- Orchestrates multi-touch lead nurturing sequence
- Touch 1 (0s): SMS with booking link
- Touch 2 (60s): AI callback attempt
- Touch 3 (5m): Follow-up SMS if no booking
- Touch 4/5: Scheduled follow-ups (24h, 72h)
- Respects business hours (delays during off-hours)

**Brain (`utils/brain.js`)**
- Interfaces with Anthropic API for:
  - Call summary generation
  - Sentiment analysis
  - Lead qualification
  - Email reply classification
- Handles timeouts and fallback responses

**Lead Scoring (`utils/leadScoring.js`)**
- Calculates lead quality score (0-100) based on:
  - Call sentiment (positive/neutral/negative)
  - Duration (longer = more engaged)
  - Booking outcome (booked = highest)
  - Response velocity (faster = more interested)

**Conversation Intelligence (`utils/conversationIntelligence.js`)**
- Extracts key information from call transcripts:
  - Sentiment (positive/neutral/negative)
  - Intent (booking/information/complaint)
  - Objections and solutions
  - Next steps

#### 3. Data Access Layer (Database Adapter)
- **Responsibility**: Abstract database operations, handle queries/mutations
- **Files**: `utils/dbAdapter.js`, `utils/migrations.js`
- **Key Features**:
  - SQLite via better-sqlite3 (synchronous)
  - Schema versioning via migrations
  - WAL mode for concurrent access
  - Connection pooling and timeouts
  - Health checking and diagnostics

**Database Schema:**
```sql
-- Clients (configuration)
CREATE TABLE clients (
  id UUID PRIMARY KEY,
  business_name TEXT,
  owner_email TEXT,
  retell_agent_id TEXT,
  retell_phone TEXT,
  twilio_phone TEXT,
  calcom_booking_link TEXT,
  timezone TEXT,
  avg_ticket REAL,
  is_active BOOL,
  created_at TIMESTAMP
);

-- Calls (Retell AI voice calls)
CREATE TABLE calls (
  id UUID PRIMARY KEY,
  client_id UUID,
  call_id TEXT,
  caller_phone TEXT,
  direction TEXT, -- inbound|outbound
  duration INT,
  outcome TEXT, -- booked|missed|transferred|voicemail
  summary TEXT,
  sentiment TEXT, -- positive|neutral|negative
  score INT, -- 0-100
  created_at TIMESTAMP
);

-- Messages (SMS and chat)
CREATE TABLE messages (
  id UUID PRIMARY KEY,
  client_id UUID,
  lead_id UUID,
  phone TEXT,
  channel TEXT, -- sms|telegram|form_reply
  direction TEXT, -- inbound|outbound
  body TEXT,
  reply_text TEXT,
  reply_classification TEXT, -- interested|not_interested|qualified
  created_at TIMESTAMP
);

-- Leads (prospects being qualified)
CREATE TABLE leads (
  id UUID PRIMARY KEY,
  client_id UUID,
  phone TEXT,
  email TEXT,
  name TEXT,
  service TEXT,
  source TEXT, -- missed_call|form|sms_inbound
  stage TEXT, -- new|contacted|qualified|booked|completed|lost
  score INT, -- 0-100
  sentiment TEXT,
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);

-- Job Queue (async task execution)
CREATE TABLE job_queue (
  id UUID PRIMARY KEY,
  type TEXT, -- speed_to_lead_sms|speed_to_lead_callback|followup_sms|etc
  payload TEXT, -- JSON
  scheduled_at TIMESTAMP,
  status TEXT, -- pending|processing|completed|failed|cancelled
  attempts INT,
  max_attempts INT,
  error_message TEXT,
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);

-- Audit Logs (security)
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY,
  action TEXT, -- auth_success|auth_failure|api_call|data_update
  clientId UUID,
  details TEXT, -- JSON
  created_at TIMESTAMP
);

-- Additional tables: appointments, emails_sent, prospects, job_queue
```

#### 4. Integration Layer
- **Responsibility**: Abstract external API calls, handle retries, rate limiting
- **Key Integrations**:

**Retell AI (`routes/retell.js`)**
- Webhook: Capture call events (started, ended, analyzed)
- Actions: Create outbound calls, get transcripts
- Failure handling: Circuit breaker pattern

**Twilio (`routes/twilio.js`)**
- Webhook: Receive inbound SMS
- Actions: Send SMS, check delivery status
- Signature verification: HMAC-SHA1

**Cal.com (`routes/calcom-webhook.js`)**
- Webhook: Booking created/cancelled/rescheduled
- Actions: Query bookings, cancel bookings
- Lead status sync: Update lead stage when booking confirmed

**Telegram (`routes/telegram.js` + `utils/telegram.js`)**
- Webhook: Bot messages and callback queries
- Commands: /stats, /leads, /calls
- Inline buttons: Interactive lead management
- Real-time notifications: Lead updates, booking confirmations

**Email (`utils/emailSender.js`, `utils/emailTemplates.js`)**
- SMTP via Nodemailer
- Template rendering with variables
- Tracking pixels for opens/clicks
- Reply parsing via mailparser
- Campaign management

#### 5. Infrastructure Layer
- **Job Queue (`utils/jobQueue.js`)**
  - Persistent async task execution
  - Scheduled jobs (SMS, callbacks, follow-ups)
  - Automatic retry with exponential backoff
  - Job cleanup (old jobs deleted after 7 days)
  - Processing interval: 15 seconds

- **Rate Limiter (`utils/rateLimiter.js`)**
  - In-memory bounded rate limiter (LRU cache)
  - 120 requests per 60 seconds per client/IP
  - Automatic cleanup of old entries
  - Returns remaining quota and reset time

- **Logger (`utils/logger.js`)**
  - File-based structured logging
  - Rotation: New file per day
  - Levels: debug, info, warn, error
  - Component prefixes: [retell], [twilio], [jobQueue]

- **Backup (`utils/backup.js`)**
  - Daily automated backups
  - SQLite WAL checkpoint before backup
  - Backup retention: 7 days
  - Cloud upload support (S3, GCS)

- **WebSocket (`utils/websocket.js`)**
  - Real-time dashboard updates
  - Lead status changes
  - Call summaries
  - Message notifications

- **Monitoring (`utils/monitoring.js`)**
  - Error tracking and reporting
  - Sentry integration (optional)
  - Metrics aggregation
  - Health status checks

---

## Data Flow

### 1. Lead Lifecycle

```
┌─────────────────────────────────────────────────────────────┐
│                    LEAD LIFECYCLE                           │
└─────────────────────────────────────────────────────────────┘

Stage: NEW (Initial contact)
├─ Source: form submission, missed call, SMS inbound
├─ Action: Create lead record, trigger speed-to-lead
├─ Status: Auto-advanced after first contact
└─ Example: Customer fills form → Lead created with stage=new

        ↓

Stage: CONTACTED (First touch)
├─ Touch 1: SMS with booking link
├─ Touch 2: AI callback (1 minute later)
├─ Touch 3: Follow-up SMS (5 minutes later)
└─ Outcome: Either books or moves to next stage

        ↓

Stage: QUALIFIED (Interest confirmed)
├─ Triggered by: Positive sentiment, engaged conversation
├─ Lead score: > 70
├─ Action: Enqueue 24h follow-up email
└─ Hold time: Awaiting decision or next action

        ↓

Stage: BOOKED (Commitment secured)
├─ Triggered by: Cal.com booking webhook
├─ Actions:
│  ├─ Cancel pending speed-to-lead jobs
│  ├─ Send booking confirmation SMS
│  ├─ Notify business owner (Telegram)
│  └─ Update revenue attribution
├─ Appointment tracking: Sync with Cal.com
└─ Reminders: Auto-sent 24h before appointment

        ↓

Stage: COMPLETED (Service delivered)
├─ Manual or webhook-triggered update
├─ Actions: Archive from active leads, calculate revenue
├─ Data: Retained indefinitely for reporting
└─ Feedback: Optional post-service survey

        OR

Stage: LOST (No conversion)
├─ Triggered by: Manual mark as lost or 72h no engagement
├─ Triggers: Last follow-up email sent
├─ Actions: Mark as inactive, remove from auto-nurture
└─ Retention: Delete after 30 days (configurable)
```

### 2. Speed-to-Lead Sequence

```
Time    Event                 Action                    Database
────────────────────────────────────────────────────────────────────
T+0s    Form submitted       enqueueJob(sms)          job_queue: pending

T+15s   Job processor runs   sendSMS(booking link)    messages: outbound SMS

T+30s   Customer sees SMS    (waiting for response)

T+60s   Job processor runs   enqueueJob(callback)     job_queue: pending

T+65s   Callback initiated   retell.create-call       calls: outbound

T+120s  AI agent answers     Conversation happens    messages: AI transcript

T+240s  Call ends            call_analyzed event     calls: completed, summary
                                                       leads: stage updated, score calculated

T+300s  Job processor runs   enqueueJob(followup_sms) job_queue: pending

        ↓ If NOT booked:

T+305s  Follow-up SMS sent   sendSMS(confirm interest) messages: outbound

T+1D    24h follow-up        enqueueJob(email)       job_queue: pending

T+3D    72h follow-up        enqueueJob(email)       job_queue: pending
```

### 3. Email Campaign Flow

```
┌──────────────────────────────────────────────────┐
│  API: POST /api/outreach/send-campaign           │
└──────────────────────────────────────────────────┘
                    ↓
    Validate campaign params
                    ↓
    For each prospect:
    ├─ Render template (substitute {{variables}})
    ├─ Generate email ID (UUID)
    ├─ Insert tracking pixel: <img src="/t/open/ID">
    ├─ Replace links: /t/click/ID?url=TARGET
    ├─ Send via SMTP
    └─ Record in emails_sent table
                    ↓
    Return: sent count, campaign_id, tracking URLs
                    ↓
    Background: Email Auto-Classifier (every 5 minutes)
    ├─ Find unclassified replies
    ├─ Call Anthropic API for sentiment analysis
    ├─ Update emails_sent with classification
    └─ Trigger follow-ups if "interested"
```

### 4. Call Processing Flow

```
Retell Webhook: call_started
                    ↓
        Create call record (minimal)
        calls: { call_id, client_id, caller_phone, direction }

        ↓ Customer talks to AI ↓

Retell Webhook: call_analyzed
                    ↓
    ┌─ Fetch full call data from Retell API
    ├─ Detect call outcome:
    │  ├─ If booking link mentioned → outcome = 'booked'
    │  ├─ If transferred → outcome = 'transferred'
    │  ├─ If voicemail → outcome = 'voicemail'
    │  └─ Otherwise → outcome = 'missed' or 'completed'
    │
    ├─ Generate summary (if missing) via Anthropic
    ├─ Analyze sentiment: positive|neutral|negative
    ├─ Calculate lead score (0-100)
    ├─ Update call record
    │  calls: { summary, sentiment, score, outcome, duration }
    │
    ├─ Update lead record
    │  leads: { stage, sentiment, score, updated_at }
    │
    ├─ If booking confirmed:
    │  └─ Cancel pending speed-to-lead jobs
    │
    ├─ If quality lead (score > 70):
    │  └─ Enqueue follow-up email (24h)
    │
    ├─ Notify owner:
    │  └─ Send Telegram message with call summary
    │
    └─ Store transcript
       messages: direction='inbound', channel='call'
```

---

## Technology Stack

### Runtime & Framework

| Component | Technology | Version | Purpose |
|-----------|-----------|---------|---------|
| Runtime | Node.js | 20+ | JavaScript execution |
| Framework | Express.js | 4.21+ | HTTP server & routing |
| Language | JavaScript | ES2020+ | Application code |

### Database

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Primary | SQLite 3 (better-sqlite3) | Embedded, serverless database |
| Mode | WAL (Write-Ahead Logging) | Concurrent read/write access |
| Future | PostgreSQL (ready) | Horizontal scaling option |
| Adapter | dbAdapter.js | Abstract DB layer for easy migration |

**Why SQLite?**
- ✅ No separate server or infrastructure needed
- ✅ ACID compliance, foreign key constraints
- ✅ WAL mode enables high concurrency
- ✅ Full backups are just file copies
- ✅ Easy to migrate to PostgreSQL if needed

### External APIs

| Service | Purpose | Why Chosen |
|---------|---------|-----------|
| Retell AI | Voice AI, call handling | Best-in-class SOTA AI voice |
| Anthropic Claude | Text summarization, classification | Excellent reasoning, cost-effective |
| Twilio | SMS sending & receiving | Reliable SMS infrastructure |
| Cal.com | Scheduling & bookings | Open-source, self-hostable, flexible |
| Telegram | Bot notifications | Free, reliable, widespread |
| Google Places | Business prospect scraping | Comprehensive business directory |

### Key Libraries

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "^0.32.0",      // Claude API
    "better-sqlite3": "^11.6.0",         // Sync SQLite
    "cors": "^2.8.5",                    // CORS middleware
    "express": "^4.21.0",                // HTTP framework
    "mailparser": "^3.9.5",              // Parse emails
    "nodemailer": "^6.9.0",              // Send emails
    "twilio": "^5.3.0",                  // Twilio SDK
    "ws": "^8.20.0"                      // WebSockets
  }
}
```

---

## Security Model

### Authentication & Authorization

**Three-Level Access Control:**

1. **No Auth Required** (Public Endpoints)
   - `/health` - Health checks
   - `/api/onboard` - Client signup
   - `/webhooks/*` - Webhook endpoints (signature verified instead)
   - `/t/open`, `/t/click` - Email tracking pixels

2. **Global Admin Auth** (Master Key)
   - `ELYVN_API_KEY` environment variable
   - Full access to all `/api/*` endpoints
   - Can manage all clients and data

3. **Per-Client Auth** (Scoped Keys)
   - Generated per client via API
   - Stored as SHA256 hash in database
   - Permissions: read, write (role-based)
   - Expiration: optional `expires_at` field
   - Tracking: `last_used_at` timestamp

### Webhook Security

**Signature Verification:**

```javascript
// Retell: HMAC-SHA256
const expected = createHmac('sha256', RETELL_WEBHOOK_SECRET)
  .update(JSON.stringify(payload))
  .digest('hex');
if (signature !== expected) return 401;

// Twilio: HMAC-SHA1
const data = url + Object.keys(params).sort()
  .reduce((acc, key) => acc + key + params[key], '');
const expected = createHmac('sha1', TWILIO_AUTH_TOKEN)
  .update(data).digest('base64');
if (signature !== expected) return 401;

// Telegram: Bearer token
if (token !== TELEGRAM_WEBHOOK_SECRET) return 403;
```

### Data Protection

**In Transit:**
- HTTPS enforced in production (via reverse proxy)
- CORS whitelist configured via `CORS_ORIGINS`
- Webhook secrets stored in environment (never in code)

**At Rest:**
- SQLite database encrypted via native SQLite Encrypt extension (optional)
- API keys stored as SHA256 hashes
- Passwords never stored (OAuth where possible)
- Audit logs track all API access

**Sensitive Data Handling:**
- Phone numbers: Never logged in full (masked in logs: `+1555****567`)
- Email addresses: Hashed when possible
- Passwords: Never stored
- API keys: Hashed + salted, no plaintext ever returned

### Rate Limiting

```javascript
// Per IP/Client
- 120 requests per 60 seconds (production)
- 5 onboarding requests per minute per IP
- 10 form submissions per 60 seconds per IP
- 10 Telegram callbacks per 60 seconds per chat ID

// Backpressure
- In-memory LRU cache (max 10,000 entries)
- Automatic cleanup of old entries
- Returns 429 with Retry-After header
```

### Input Validation

All external input is validated:

```javascript
// UUID validation
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
  return 400; // Invalid format
}

// Phone validation (E.164)
if (!/^\+[1-9]\d{1,14}$/.test(phone)) {
  return 400; // Invalid format
}

// Email validation
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  return 400; // Invalid format
}

// URL validation (block javascript:, data:, vbscript:)
if (!/^https?:\/\//.test(url) || /^(javascript|data|vbscript):/i.test(url)) {
  return 400; // Invalid protocol
}

// SQL injection prevention
// Always use parameterized queries:
db.prepare("SELECT * FROM users WHERE id = ?").get(untrustedId);
// Never concatenate: SELECT * FROM users WHERE id = ${untrustedId}
```

### Audit & Compliance

**Audit Logging:**
- All API key usage: `logAudit(db, { action: 'auth_success', clientId, ip, path })`
- Data access: `POST /api/leads/:clientId` → logged with timestamp
- Administrative actions: Client creation, deletion, updates

**Data Retention:**
- Call records: 90 days
- Messages: 60 days
- Leads (lost): 30 days
- Audit logs: 90 days
- Backups: 7 days rolling window

**Compliance Hooks:**
- GDPR: Data export via `/api/clients/:clientId/export` (not yet implemented)
- GDPR: Data deletion via `/api/clients/:clientId/delete` (soft delete only)
- HIPAA: Not compliant (healthcare data not supported)
- SOC2: Audit logs provide compliance trail

---

## Scaling & Performance

### Horizontal Scaling

**Current Limits (Single Instance):**
- SQLite: ~1000 requests/second with WAL mode
- Memory: 512MB base + request buffers
- Connections: Limited by Node.js event loop (~10k concurrent)

**Bottleneck: Shared SQLite Database**

Solution: Multiple instances + shared database file (NFS) or migrate to PostgreSQL.

```bash
# Setup multiple instances with shared SQLite
NAS:/mnt/shared/elyvn.db
├─ Instance 1 (Port 3001) → mounts NAS
├─ Instance 2 (Port 3002) → mounts NAS
└─ Instance 3 (Port 3003) → mounts NAS
    ↓ Load Balancer (nginx)
    ↓ Distributes requests
```

### Vertical Scaling

**Single Instance Optimization:**

1. **Database:**
   - WAL mode (done)
   - Larger cache (64MB, from 2MB default)
   - Busy timeout (10s, prevents lock timeouts)
   - Pragmas optimized: synchronous=NORMAL, journal_mode=WAL

2. **Application:**
   - Node.js heap size: `--max-old-space-size=2048`
   - Connection pool (future if moving to PostgreSQL)
   - Caching layer (Redis, future)

3. **Network:**
   - Gzip compression on responses
   - HTTP/2 with multiplexing
   - Keep-alive connections

### Performance Metrics

**Target Latencies:**
- Health check: < 50ms
- API reads (stats, calls, leads): < 200ms
- API writes (create lead): < 500ms
- Webhook processing: < 5s (async, doesn't block)

**Target Throughput:**
- 1000 webhook events/second (speed-to-lead, call events)
- 100 API requests/second
- 50 new leads/second (form + SMS inbound)

**Monitoring:**
- Request latency histogram
- Database query performance
- Job queue depth
- Memory usage trends

### Caching Strategy

**Currently:** No caching (all reads hit database)

**Future Improvements:**
- Redis cache for frequently accessed data:
  - Client configurations (TTL: 1h)
  - Lead scores (TTL: 5m)
  - Call transcripts (TTL: 24h)

**Database Indexes:**
```sql
CREATE INDEX idx_calls_client_created ON calls(client_id, created_at);
CREATE INDEX idx_messages_client_phone ON messages(client_id, phone);
CREATE INDEX idx_leads_client_stage ON leads(client_id, stage);
CREATE INDEX idx_job_queue_scheduled ON job_queue(scheduled_at, status);
CREATE INDEX idx_emails_sent_prospect ON emails_sent(prospect_id, status);
```

---

## Design Decisions

### Why Synchronous SQLite over Async PostgreSQL?

**Pros of SQLite:**
- No operational overhead (no separate DB server)
- Easy development (file-based, zero config)
- Simple backups (just copy the file)
- Excellent for< 1GB databases
- WAL mode provides high concurrency

**Cons:**
- Single-writer limitation (but WAL helps)
- Not horizontally scalable past shared NFS

**Decision Rationale:**
- Fits current scale (< 10M records)
- Easier to deploy to serverless platforms (Railway, Vercel Functions)
- Can migrate to PostgreSQL later if needed (dbAdapter pattern)

### Why Persistent Job Queue instead of Redis?

**Pros of SQLite Job Queue:**
- No external dependency
- Survives server restarts (persistent)
- Automatic cleanup (DELETE old jobs)
- Transactional (all-or-nothing execution)

**Cons:**
- Slower than Redis
- No job locking (single-threaded processing)
- No pub/sub for real-time updates

**Decision Rationale:**
- Reliability more important than speed
- Job throughput is low (20 jobs/processing)
- Avoids Redis operational complexity
- Future: Can switch to Celery/RabbitMQ if needed

### Why WebSockets for Real-Time?

**Alternatives Considered:**
1. **Polling** - Inefficient, hammers database
2. **Server-Sent Events (SSE)** - Works but less flexible
3. **WebSockets** - Bi-directional, real-time, chosen

**Usage:**
- Dashboard subscribes to client's lead updates
- Sends real-time notifications: new call, lead scored, booking confirmed
- Reduces need for API polling

### Why Twilio for SMS instead of building custom?

**Build Custom Pros:**
- Full control, no per-message cost

**Build Custom Cons:**
- Need SMPP provider relationship
- Requires telecom knowledge
- Compliance complexity (SMS regulations)
- Support burden

**Use Twilio Pros:**
- Reliable, global delivery
- Handles compliance (CAN-SPAM, GDPR)
- Good REST API
- Pay-as-you-go pricing

### Why Email-first Outreach instead of Phone-first?

**Phone-first Pros:**
- Immediate, personal connection
- Higher conversion

**Phone-first Cons:**
- Expensive (Retell outbound costs)
- Regulatory burden (DNC lists, CID requirements)
- Not scalable to thousands of prospects

**Email-first Rationale:**
- Scalable to unlimited prospects
- Lower cost per contact
- Trackable (opens, clicks, replies)
- Less regulatory burden
- Can follow up with callback if interested

---

## Future Architecture Improvements

### Phase 2: PostgreSQL Migration

```javascript
// dbAdapter.js would support both SQLite and PostgreSQL
if (process.env.DATABASE_URL.startsWith('postgres://')) {
  // Use pg pool instead of better-sqlite3
  db = new Pool({ connectionString: process.env.DATABASE_URL });
  // Migrations still work (SQL is compatible)
}
```

**Benefits:**
- Horizontal scaling
- Connection pooling
- Better multi-tenant isolation
- Larger data volumes (100GB+)

### Phase 3: Message Queue

Replace job_queue with RabbitMQ/Apache Kafka:
- Distributed job processing
- At-least-once delivery guarantees
- Scaled message throughput
- Separate worker processes

### Phase 4: Caching Layer

Add Redis for:
- Session storage
- Lead score caching
- API response caching
- Real-time notifications

### Phase 5: Analytics Pipeline

Stream data to data warehouse:
- BigQuery / Snowflake
- Real-time dashboards
- ML-based lead scoring
- Revenue attribution

---

## Deployment Architecture

### Development
```
Local Machine
├─ Node.js + npm
├─ SQLite database
├─ .env with test credentials
└─ http://localhost:3001
```

### Production (Railway)
```
Railway
├─ Nixpacks (Node.js 20, npm)
├─ Application Process
│  ├─ Port: $PORT (dynamic)
│  └─ Volumes: /data/ (persistent)
├─ SQLite Database
│  └─ Stored in: /data/elyvn.db
├─ Automatic scaling (CPU/memory-based)
├─ Custom domain with HTTPS
└─ Environment variables from dashboard
```

### High Availability
```
Nginx Reverse Proxy
├─ Port 443 (HTTPS)
├─ Load balancing across 3 instances
└─ Session affinity for WebSockets
    ├─ Instance 1 (Port 3001)
    ├─ Instance 2 (Port 3002)
    └─ Instance 3 (Port 3003)
         ↓
      Shared NFS Mount
         ↓
      elyvn.db (SQLite with WAL)
```

**Considerations:**
- WAL mode handles concurrent writes well
- Long-running transactions should be minimized
- Disk I/O is potential bottleneck (consider SSD only)
- Better solution: migrate to PostgreSQL with multiple replicas
