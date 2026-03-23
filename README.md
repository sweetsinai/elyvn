# ELYVN

AI operations platform for service businesses. Answers calls, auto-replies to SMS, scores leads, schedules follow-ups, notifies the business owner via Telegram, and autonomously decides what to do next.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      ELYVN BRAIN                        │
│              (Claude Orchestrator)                       │
│  Sees full lead timeline. Decides next actions.         │
│  Runs after every call, SMS, and form submission.       │
└───────────┬──────────────┬──────────────┬───────────────┘
            │              │              │
     ┌──────▼──────┐ ┌────▼─────┐ ┌──────▼──────┐
     │   Retell    │ │  Twilio  │ │  Telegram   │
     │  (Voice)    │ │  (SMS)   │ │  (Notify)   │
     └─────────────┘ └──────────┘ └─────────────┘
            │              │              │
            └──────────────┼──────────────┘
                           │
                    ┌──────▼──────┐
                    │   SQLite    │
                    │  (WAL mode) │
                    └─────────────┘
```

**Two processes run concurrently:**

| Process | Runtime | Port | Purpose |
|---------|---------|------|---------|
| Bridge | Node.js (Express) | 3001 | Webhooks, API, Telegram commands, brain |
| MCP Server | Python (FastMCP) | 8000 | AI tools, DB init, knowledge bases |

## Project Structure

```
elyvn/
├── server/
│   ├── bridge/                    # Node.js Express server
│   │   ├── index.js               # Entry point, middleware, route registration
│   │   ├── routes/
│   │   │   ├── retell.js          # Retell webhook (call_started, call_ended, call_analyzed, transfer)
│   │   │   ├── twilio.js          # Twilio SMS webhook (inbound SMS, CANCEL, YES keywords)
│   │   │   ├── telegram.js        # Telegram bot commands + callback buttons
│   │   │   ├── forms.js           # Universal form webhook (CF7, Typeform, generic)
│   │   │   ├── api.js             # REST API (clients, calls, leads, messages, followups)
│   │   │   └── outreach.js        # Cold outreach campaigns
│   │   └── utils/
│   │       ├── brain.js           # Autonomous decision engine (Claude orchestrator)
│   │       ├── leadMemory.js      # Builds full lead timeline across all channels
│   │       ├── actionExecutor.js  # Executes brain decisions (SMS, followups, notifications)
│   │       ├── sms.js             # Twilio SMS sender with rate limiting + retry
│   │       ├── telegram.js        # Telegram Bot API client + notification formatters
│   │       ├── scheduler.js       # Cron: daily summary, weekly report, followup processor, lead review
│   │       ├── speed-to-lead.js   # Triple-touch sequence (0s SMS → 60s AI callback → 5min followup)
│   │       └── calcom.js          # Cal.com booking integration
│   ├── mcp/                       # Python FastMCP server
│   │   ├── main.py                # MCP entry point, tool registration
│   │   ├── db.py                  # SQLite schema init (aiosqlite)
│   │   ├── clients.py             # Knowledge base loader
│   │   ├── seed.py                # Database seeder
│   │   ├── knowledge_bases/       # Client KB files (JSON, keyed by client UUID)
│   │   └── tools/
│   │       ├── voice.py           # Call processing tools
│   │       ├── messaging.py       # Message handling tools
│   │       ├── followup.py        # Follow-up scheduling tools
│   │       ├── booking.py         # Cal.com booking tools
│   │       ├── intelligence.py    # Lead scoring + call analysis
│   │       ├── reporting.py       # Weekly report generation
│   │       ├── scraper.py         # Google Maps business scraper
│   │       ├── outreach.py        # Cold email writer + sender
│   │       └── reply_handler.py   # Email reply classification
│   └── requirements.txt          # Python dependencies
├── dashboard/                     # React + Vite frontend (builds to server/bridge/public/)
├── tests/
│   └── stress/
│       ├── malformed.js           # 31 payload fuzzing tests
│       ├── concurrency.js         # 30 race condition tests
│       └── db_integrity.js        # 12 database integrity checks
├── Dockerfile                     # Multi-stage: Python 3.12 + Node 22
├── railway.toml                   # Railway deployment config
└── package.json                   # Root scripts (dev, start, build)
```

## Database Schema

SQLite with WAL mode and 5-second busy timeout. 10 tables:

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `clients` | Business accounts | `id`, `business_name`, `retell_phone`, `twilio_phone`, `telegram_chat_id`, `is_active` |
| `calls` | Call records | `call_id`, `client_id`, `caller_phone`, `duration`, `outcome`, `score`, `summary`, `transcript` |
| `leads` | Lead records | `phone`, `client_id`, `score`, `stage`, `calcom_booking_id` |
| `messages` | SMS logs | `phone`, `client_id`, `direction`, `body`, `confidence`, `reply_source` |
| `followups` | Scheduled touches | `lead_id`, `touch_number`, `type`, `content`, `scheduled_at`, `status` |
| `prospects` | Outreach targets | `email`, `business_name`, `industry` |
| `campaigns` | Email campaigns | `name`, `status`, `template` |
| `campaign_prospects` | Campaign membership | `campaign_id`, `prospect_id` |
| `emails_sent` | Email tracking | `prospect_id`, `status`, `reply_classification` |
| `weekly_reports` | Performance reports | `client_id`, `week_start`, `calls_answered`, `appointments_booked` |

**Indexes:** `calls(client_id, caller_phone, call_id, created_at)`, `leads(client_id, phone)`, `messages(client_id, phone)`, `followups(lead_id, status, scheduled_at)`.

## Event Flows

### Inbound Call (Retell)

```
Retell webhook POST /webhooks/retell
  └→ call_started: insert call record, match client by phone or agent_id
  └→ call_ended:
      1. Fetch transcript from Retell API (fallback to webhook payload)
      2. Generate summary via Claude (from transcript or call_analysis.call_summary)
      3. Score lead 1-10 via Claude
      4. Determine outcome (booked/transferred/missed/voicemail/info_provided)
      5. Upsert lead record
      6. Schedule follow-up sequence
      7. Missed call → trigger speed-to-lead (instant text-back + AI callback)
      8. Transfer/complaint → notify owner via SMS
      9. Telegram notification (call card with transcript button)
     10. BRAIN: analyze full lead history, decide next actions
  └→ call_analyzed: backfill transcript + summary if not already set
  └→ agent_transfer / dtmf(*): handle live transfer to owner
```

### Inbound SMS (Twilio)

```
Twilio webhook POST /webhooks/twilio (application/x-www-form-urlencoded)
  └→ "CANCEL" → cancel Cal.com booking
  └→ "YES" → send booking link
  └→ Normal message:
      1. Check is_active (if paused, log only + notify owner)
      2. Rate limit check (5-min cooldown per number)
      3. Load client knowledge base
      4. Claude generates reply (JSON: {reply, confidence})
      5. Low confidence → generic reply + escalate to owner
      6. Upsert lead, log inbound + outbound messages
      7. New lead → schedule nudge followup
      8. Telegram notification (with confidence indicator)
      9. BRAIN: analyze full history, decide next actions
```

### Form Submission

```
POST /webhooks/form/:clientId
  └→ Normalize phone (supports 10-digit, 11-digit, parentheses, dashes)
  └→ Parse field names (Contact Form 7, Typeform, generic)
  └→ No phone → email-only lead + Telegram notify
  └→ With phone → upsert lead, trigger speed-to-lead sequence
```

### Brain (Autonomous Decision Engine)

```
Event arrives → basic processing → BRAIN fires:
  1. leadMemory.js: build full timeline (calls + SMS + followups, sorted chronologically)
  2. brain.js: call Claude with timeline + KB + guardrails
  3. Claude returns structured actions: send_sms, schedule_followup, cancel_pending_followups,
     update_lead_stage, update_lead_score, notify_owner, log_insight, no_action
  4. actionExecutor.js: execute each action (Twilio SMS, DB updates, Telegram alerts)

Guardrails:
  - Max 3 brain-initiated SMS per lead per 24 hours
  - Skip if lead was transferred to owner (owner is handling)
  - Skip if lead sent opt-out signal (stop/unsubscribe)
  - Brain errors never crash webhooks
```

### Scheduled Tasks

| Task | Interval | What it does |
|------|----------|--------------|
| Follow-up processor | Every 5 min | Process due followups through the brain |
| Daily summary | 7 PM | Telegram summary of today's calls, bookings, messages |
| Weekly report | Monday 8 AM | Telegram weekly performance report + persist to DB |
| Daily lead review | 9 AM | Brain reviews stale leads (inactive 2+ days, score >= 5) |

## Telegram Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Connect account via onboarding link |
| `/today` | Today's booked appointments |
| `/stats` | Last 7 days: calls, bookings, missed, messages, revenue |
| `/calls` | Last 5 calls with outcome, score, summary |
| `/leads` | Hot leads (score >= 7, not completed/lost) |
| `/brain` | Last 10 autonomous brain actions |
| `/pause` | Pause AI answering (calls ring through, SMS logged only) |
| `/resume` | Resume AI answering |
| `/help` | Show all commands |

**Callback buttons:** Full transcript (on call notifications), Good reply / I'll handle this (on SMS notifications).

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Claude API key for summaries, scoring, brain, SMS replies |
| `RETELL_API_KEY` | Yes | Retell API key for fetching call transcripts |
| `TWILIO_ACCOUNT_SID` | Yes | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Yes | Twilio auth token |
| `TWILIO_PHONE_NUMBER` | Yes | Twilio phone number (e.g. +13612139099) |
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot token |
| `TELEGRAM_WEBHOOK_SECRET` | Yes | Secret for verifying Telegram webhook requests |
| `DATABASE_PATH` | No | SQLite path (default: `server/mcp/elyvn.db`, Railway: `/data/elyvn.db`) |
| `CALCOM_API_KEY` | No | Cal.com API key for booking management |
| `GOOGLE_MAPS_API_KEY` | No | Google Maps API for business scraping |
| `SMTP_USER` | No | Gmail SMTP for cold outreach |
| `SMTP_PASS` | No | Gmail app password |
| `ELYVN_API_KEY` | No | API key for /api routes (no auth if unset) |
| `PORT` | No | Server port (default: 3001) |

## Deployment

Deployed on Railway with a persistent volume at `/data` for the SQLite database.

```bash
# Local development
npm run dev       # Starts MCP + bridge + dashboard (Vite dev server)

# Production
npm run build     # Build dashboard → server/bridge/public/
npm start         # Starts MCP + bridge (concurrently)

# Deploy to Railway
git push origin main   # Auto-deploys if connected
railway up --detach    # Manual deploy from local
```

**Dockerfile:** Python 3.12 base, installs Node 22, builds dashboard, exposes ports 3001 + 8000.

**Railway config:**
- Health check: `GET /health`
- Restart policy: on_failure (max 3 retries)
- Volume: mounted at `/data` for persistent SQLite

## Webhook URLs

Configure these in external services:

| Service | URL |
|---------|-----|
| Retell | `https://joyful-trust-production.up.railway.app/webhooks/retell` |
| Twilio SMS | `https://joyful-trust-production.up.railway.app/webhooks/twilio` |
| Telegram | `https://joyful-trust-production.up.railway.app/webhooks/telegram` |
| Web Forms | `https://joyful-trust-production.up.railway.app/webhooks/form/:clientId` |

## API Endpoints

All `/api` routes require `x-api-key` header when `ELYVN_API_KEY` is set.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Comprehensive health check (DB, env vars, memory, uptime) |
| GET | `/api/clients` | List all clients |
| POST | `/api/clients` | Create a new client |
| PUT | `/api/clients/:id` | Update client fields |
| GET | `/api/calls` | List calls (query: `client_id`, `limit`, `offset`) |
| GET | `/api/leads` | List leads (query: `client_id`, `limit`, `offset`) |
| GET | `/api/messages` | List messages (query: `client_id`, `limit`, `offset`) |
| GET | `/api/followups` | List followups (query: `client_id`, `status`) |

## Testing

```bash
# Malformed payload fuzzing (31 tests)
node tests/stress/malformed.js

# Concurrency + race conditions (30 tests)
node tests/stress/concurrency.js

# Database integrity checks (12 checks)
node tests/stress/db_integrity.js
```

## Production Hardening

- Global `unhandledRejection` and `uncaughtException` handlers (process stays alive)
- Every route handler wrapped in try-catch
- Express error middleware with SyntaxError handling (returns 400 for bad JSON)
- SQLite WAL mode + 5-second busy_timeout
- Request rate limiting (120 req/min per IP)
- API key authentication on /api routes
- DB indexes on all frequently queried columns
- Telegram `sendMessage` checks `res.ok` and logs failures
- Brain errors never crash webhook handlers
- SMS rate limiting (5-min cooldown per number + max 3 brain SMS per 24h)
