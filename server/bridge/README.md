# ELYVN Bridge Server

AI-powered receptionist platform for service businesses. Handles voice calls, SMS, WhatsApp, Facebook Messenger, Instagram DM, email outreach, lead scoring, appointment booking, and autonomous follow-ups — all from one backend.

## Architecture

```
                    Inbound Channels                          Outbound Channels
                    +--------------+                          +---------------+
  Phone Calls ----->| Retell AI    |    +---------------+     | Twilio SMS    |
  SMS ------------>| Twilio/Telnyx|    |               |     | Retell Calls  |
  WhatsApp ------->| Twilio WA    |--->|  ELYVN Brain  |---->| Telegram      |
  FB Messenger --->| Meta Webhook |    |  (Claude AI)  |     | SMTP Email    |
  Instagram DM --->| Meta Webhook |    |               |     | Cal.com Book  |
  Web Forms ------>| Form Webhook |    +-------+-------+     +---------------+
  Cal.com -------->| Calcom Hook  |            |
                    +--------------+            v
                                         +-----------+
                                         |  SQLite   |
                                         |  + Job    |
                                         |  Queue    |
                                         +-----------+
```

## Quick Start

```bash
# Install dependencies
npm install

# Set required env vars
export ANTHROPIC_API_KEY=sk-ant-...
export JWT_SECRET=$(openssl rand -hex 32)
export ENCRYPTION_KEY=$(openssl rand -hex 32)
export ELYVN_API_KEY=$(openssl rand -hex 32)

# Start server
npm start
# or
node index.js
```

Server runs on port 3001 by default (`PORT` env var).

## Environment Variables

### Required
| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Claude AI for brain decisions, summaries, scoring |
| `JWT_SECRET` | JWT signing (min 32 chars) |
| `ENCRYPTION_KEY` | AES-256 encryption for PII at rest |
| `ELYVN_API_KEY` | Master API key for admin endpoints |

### Communication Channels
| Variable | Purpose |
|----------|---------|
| `TWILIO_ACCOUNT_SID` | Twilio SMS + WhatsApp |
| `TWILIO_AUTH_TOKEN` | Twilio signature verification |
| `TWILIO_PHONE_NUMBER` | Default outbound SMS number |
| `RETELL_API_KEY` | Retell AI voice calls |
| `TELNYX_API_KEY` | Alternative SMS provider |
| `TELNYX_MESSAGING_PROFILE_ID` | Telnyx messaging profile |
| `META_VERIFY_TOKEN` | Facebook/Instagram webhook verification |
| `META_APP_SECRET` | Facebook/Instagram signature verification |

### Integrations
| Variable | Purpose |
|----------|---------|
| `CALCOM_API_KEY` | Cal.com appointment booking |
| `CALCOM_WEBHOOK_SECRET` | Cal.com webhook HMAC verification |
| `STRIPE_SECRET_KEY` | Stripe billing |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook verification |
| `STRIPE_PRICE_STARTER` | Stripe price ID for $299 plan |
| `STRIPE_PRICE_GROWTH` | Stripe price ID for $499 plan |
| `STRIPE_PRICE_SCALE` | Stripe price ID for $799 plan |
| `TELEGRAM_BOT_TOKEN` | Telegram bot for owner notifications |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram webhook verification |

### Email
| Variable | Purpose |
|----------|---------|
| `SMTP_HOST` | SMTP server for outbound email |
| `SMTP_PORT` | SMTP port (default 587) |
| `SMTP_USER` | SMTP username |
| `SMTP_PASS` | SMTP password |
| `IMAP_HOST` | IMAP for reply checking (default imap.gmail.com) |

### Optional
| Variable | Purpose |
|----------|---------|
| `SENTRY_DSN` | Sentry error tracking |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OpenTelemetry tracing |
| `REDIS_URL` | Redis for nonce dedup (falls back to in-memory) |
| `SINGLE_TENANT_MODE` | Set to `true` for single-client deployments |
| `BASE_URL` | Server base URL (auto-detected on Railway) |

## Database

SQLite by default (`data/elyvn.db`). 39 migrations run automatically on startup.

### Core Tables
| Table | Purpose |
|-------|---------|
| `clients` | Business accounts (multi-tenant) |
| `leads` | Customer leads with scoring |
| `calls` | Voice call records + transcripts |
| `messages` | SMS/chat message history |
| `appointments` | Cal.com bookings |
| `followups` | Scheduled follow-up touchpoints |
| `job_queue` | Persistent async job queue |
| `dead_letter_queue` | Failed jobs after max retries |
| `event_store` | Append-only event sourcing log |
| `audit_log` | Security audit trail |
| `usage_records` | Monthly per-client usage metering |
| `resellers` | White-label reseller accounts |
| `referrals` | Referral tracking |

## API Endpoints

### Authentication
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/auth/signup` | None | Create account (accepts `referral_code`) |
| POST | `/auth/login` | None | Login, returns JWT |
| GET | `/auth/session` | JWT | Current session info |

### Client Management
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/clients` | API Key | List clients (admin: all, client: own) |
| POST | `/api/clients` | API Key | Create client (admin) |
| PUT | `/api/clients/:clientId` | API Key | Update client settings |

### Leads
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/leads/:clientId` | API Key | List leads (filterable by stage, score, search) |
| PUT | `/api/leads/:clientId/:leadId` | API Key | Update stage, revenue_closed, job_value |
| GET | `/api/leads/:clientId/priorities` | API Key | Top 10 leads by priority score |
| GET | `/api/leads/:clientId/:leadId/timeline` | API Key | Full event history for a lead |

### Calls
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/calls/:clientId` | API Key | Call history (filterable) |

### Analytics
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/stats/:clientId` | API Key | Weekly overview + trends |
| GET | `/api/stats/:clientId/timeseries` | API Key | Daily time-series (1-365 days) |
| GET | `/api/stats/:clientId/roi` | API Key | ROI proof: what ELYVN caught vs. would-be-missed |
| GET | `/api/intelligence/:clientId` | API Key | Booking rate, avg duration, peak hours |
| GET | `/api/reports/:clientId` | API Key | Weekly reports history |
| GET | `/api/reports/:clientId/insights` | API Key | AI-generated business intelligence |
| GET | `/api/revenue/:clientId` | API Key | Revenue funnel + cohort analysis |

### Settings & Onboarding
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/settings/:clientId` | API Key | All settings grouped by category |
| PUT | `/api/settings/:clientId` | API Key | Update settings |
| GET | `/api/onboarding/:clientId` | API Key | 7-step onboarding progress |
| POST | `/api/onboarding/:clientId/complete-step` | API Key | Mark step complete |

### Billing & Usage
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/usage/:clientId` | API Key | Monthly usage vs. plan limits |
| POST | `/api/plan/:clientId/upgrade` | API Key | Self-serve plan upgrade via Stripe |
| GET | `/billing/plans` | None | List plans and prices |
| GET | `/billing/status` | JWT | Current billing status |
| POST | `/billing/create-checkout` | JWT | Create Stripe checkout session |
| POST | `/billing/portal` | JWT | Stripe billing portal |

### CRM Export
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/exports/:clientId/leads?format=csv` | API Key | Export leads as CSV or JSON |
| GET | `/api/exports/:clientId/calls?format=csv` | API Key | Export calls as CSV or JSON |

### Referral Program
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/referral/:clientId` | API Key | Referral code + stats |
| POST | `/api/referral/apply` | API Key | Apply referral code |
| POST | `/api/referral/:clientId/activate` | API Key | Activate on first payment |

### White-Label Reseller
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/reseller/register` | None | Create reseller account |
| POST | `/api/reseller/login` | None | Reseller login |
| GET | `/api/reseller/:id/clients` | Reseller JWT | List sub-accounts |
| POST | `/api/reseller/:id/create-client` | Reseller JWT | Create white-label client |
| GET | `/api/reseller/:id/stats` | Reseller JWT | Revenue + client stats |

### ROI Calculator (Public)
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/calculator/roi` | None | Calculate ROI by industry |
| GET | `/api/calculator/benchmarks` | None | Industry benchmarks for dropdown |

### Webhooks (Inbound)
| Method | Path | Verification | Source |
|--------|------|-------------|--------|
| POST | `/webhooks/retell` | HMAC-SHA256 + nonce | Retell AI voice calls |
| POST | `/webhooks/twilio` | Twilio signature | Twilio SMS/voice |
| POST | `/webhooks/telnyx` | Telnyx signature | Telnyx SMS |
| POST | `/webhooks/whatsapp` | Twilio SHA1 HMAC | WhatsApp via Twilio |
| POST | `/webhooks/social` | Meta SHA256 HMAC | Facebook Messenger + Instagram DM |
| POST | `/webhooks/telegram` | Secret token | Telegram bot |
| POST | `/webhooks/form` | Rate limited | Website form submissions |
| POST | `/webhooks/calcom` | HMAC-SHA256 + timestamp | Cal.com bookings |
| POST | `/billing/webhook` | Stripe signature | Stripe billing events |

## AI Brain

The autonomous decision engine (`utils/brain.js`) uses Claude to analyze events and take actions.

### How It Works

1. An event arrives (call ended, SMS received, form submitted, etc.)
2. Brain loads the lead's full memory: timeline, interactions, score, stage
3. Brain loads the client's knowledge base + performance context
4. Claude analyzes everything and returns a JSON action plan
5. Actions are validated against guardrails, then executed

### 8 Action Types

| Action | What it does |
|--------|-------------|
| `send_sms` | Send SMS to the lead |
| `schedule_followup` | Queue a follow-up with delay |
| `cancel_pending_followups` | Stop all scheduled follow-ups |
| `update_lead_stage` | Move lead through pipeline |
| `update_lead_score` | Adjust score with reason |
| `book_appointment` | Create Cal.com booking |
| `notify_owner` | Alert business owner (Telegram) |
| `log_insight` | Record behavioral observation |

### Guardrails

- Max 3 AI-initiated SMS per lead per 24h
- Opt-out detection: "stop", "unsubscribe" halts all automation
- Owner transfer blocks all auto follow-up
- TCPA compliance footer auto-injected on every SMS
- Token-based per-lead locking (10s timeout) prevents race conditions
- Circuit breaker: 5 Claude failures in 60s opens circuit for 30s

## Lead Scoring

5-factor weighted model producing a 0-100 score:

| Factor | Weight | What it measures |
|--------|--------|-----------------|
| Responsiveness | 25% | Time from outreach to first response |
| Engagement | 25% | Total interactions (calls + messages) |
| Intent | 20% | Source quality + sentiment + outcomes |
| Recency | 15% | Hours since last interaction |
| Channel Diversity | 15% | Engagement across call + SMS |

Runs automatically at 6 AM daily for all active leads.

## Industry Templates

12 pre-built AI personalities with industry-specific knowledge:

| Industry | Emergency Detection | Key Capability |
|----------|-------------------|----------------|
| Dental | Pain, swelling, bleeding | Full procedure vocabulary |
| Med Spa | None | Confidential tone, no result promises |
| Salon | None | Stylist matching, walk-in availability |
| Gym | None | Free trial offers, goals assessment |
| Veterinary | Not eating 24h+, seizures, poisoning | Compassionate emergency triage |
| HVAC | Gas smell, CO alarm, no heat | Address collection for dispatch |
| Plumbing | Flooding, burst pipe, sewage | Water shut-off guidance |
| Electrical | Sparking, burning smell, exposed wires | Safety-first warnings |
| Auto Repair | None | Year/make/model collection |
| Real Estate | None | Buyer vs. seller routing |
| Legal | None | NEVER gives legal advice |
| General | None | Fallback for any industry |

40+ industry synonyms auto-map to these templates (e.g., "dental clinic" -> dental).

## Telegram Bot

Business owners manage ELYVN via Telegram. Commands are customized per plan tier.

### How It Works

1. Owner links Telegram to ELYVN via `/start <clientId>` in the bot
2. Bot sets a custom command menu based on the client's plan (starter/growth/scale)
3. Owner receives real-time notifications for calls, messages, bookings, transfers
4. Owner can reply to leads directly from Telegram (two-way SMS)

### Commands by Plan

| Command | Starter | Growth | Scale | What it does |
|---------|---------|--------|-------|-------------|
| `/status` | Yes | Yes | Yes | Dashboard: today's stats, active leads, AI status |
| `/leads` | Yes | Yes | Yes | Lead list grouped by stage |
| `/calls` | Yes | Yes | Yes | Last 5 calls with transcripts |
| `/today` | Yes | Yes | Yes | Today's + tomorrow's appointments |
| `/stats` | Yes | Yes | Yes | 7-day performance metrics |
| `/complete +phone` | Yes | Yes | Yes | Mark job done, triggers review request + rebook nudge |
| `/reviewlink` | Yes | Yes | Yes | View/set Google review link |
| `/pause` / `/resume` | Yes | Yes | Yes | Pause/resume AI answering |
| `/digest` / `/alerts` | Yes | Yes | Yes | Toggle notification mode |
| `/brain` | No | Yes | Yes | AI activity feed (last 10 decisions) |
| `/outreach` | No | No | Yes | Campaign stats (sent/replied/booked) |
| `/scrape industry city` | No | No | Yes | Find prospects on Google Maps |
| `/prospects` | No | No | Yes | Top 10 scraped prospects |

### Notification Buttons

Every notification includes inline action buttons:

- **Call notification**: "Full transcript" + "Text this caller"
- **Message notification**: "Good reply" + "I'll handle this" + "Reply to lead"
- **Escalation**: "Reply to lead"
- **Speed-to-lead**: "Cancel sequence"

### Two-Way Reply

1. Owner taps "Reply to lead" on any notification
2. Bot prompts: "Type your message below"
3. Owner types their reply
4. ELYVN sends it as SMS to the lead's phone number
5. Lead's phone number is verified against the client's leads table (prevents spoofing)

## Job Queue

Persistent async job queue with retry, dead letter queue, and idempotency.

### Job Types

| Type | Trigger | Purpose |
|------|---------|---------|
| `speed_to_lead_sms` | New lead detected | Immediate SMS response |
| `speed_to_lead_callback` | New lead detected | Outbound Retell call |
| `followup_sms` | Brain decision | Scheduled follow-up SMS |
| `appointment_reminder` | Booking created | 24h + 2h before appointment |
| `google_review_request` | Appointment completed | SMS review request 2h after appointment |
| `interested_followup_email` | Reply classified | 24h email follow-up |
| `noreply_followup` | No reply detected | Day 3 + Day 7 email follow-up |

### Retry Logic

- Max 3 attempts per job
- Exponential backoff: 2 min, 4 min, 8 min
- Failed jobs after max attempts move to `dead_letter_queue`
- Stalled jobs (stuck >30 min) recovered on startup
- Idempotency keys prevent duplicate enqueuing

## Billing

Three plans via Stripe:

| Plan | Price | Calls | SMS |
|------|-------|-------|-----|
| Starter | $299/mo | 500 | 1,000 |
| Growth | $499/mo | 1,500 | 3,000 |
| Scale | $799/mo | Unlimited | Unlimited |

- 7-day free trial on all plans
- Usage tracked per-client per-month (calls, SMS, AI decisions, emails)
- Self-serve upgrade via Stripe Checkout
- Stripe webhooks handle: checkout completed, payment succeeded/failed, subscription cancelled/updated

## White-Label Reseller System

Agencies can resell ELYVN under their own brand.

### Reseller Flow

1. Agency registers at `POST /api/reseller/register`
2. Agency logs in, gets JWT with `role: 'reseller'`
3. Agency creates sub-accounts via `POST /api/reseller/:id/create-client`
4. Each sub-account is a normal ELYVN client with `reseller_id` linking to the agency
5. Agency views stats (total clients, paying clients, MRR) at `GET /api/reseller/:id/stats`

## Referral Program

- Every new account gets a unique referral code (`ELYVN-XXXXXXXX`)
- Share via `https://elyvn.ai/signup?ref=ELYVN-XXXXXXXX`
- When a referred user signs up, the referral is recorded as `pending`
- When the referred user makes their first payment, the referrer gets $50 credit
- Credits tracked per-client in `referral_credits` column

## Security

- All SQL queries use parameterized `?` placeholders
- All webhook signatures verified with timing-safe HMAC comparison
- All Telegram HTML output escaped via `esc()` function
- PII (phone, email) encrypted at rest via AES-256
- PII masked in all log statements
- JWT with HMAC-SHA256, 24h expiry, issuer/audience validation
- Per-client API keys with rate limits
- Client tenant isolation enforced on every data endpoint
- Rate limiting: 100 req/min general, 10/min auth, 300/min webhooks
- CSRF protection, Helmet security headers, CORS allowlist
- Nonce dedup on webhooks (Redis or in-memory, 1h TTL)

## Monitoring

- `GET /health` — Database health + env vars
- `GET /metrics` — Prometheus scrape endpoint
- `GET /metrics/internal` — JSON metrics (job queue, error rate, WebSocket connections)
- Sentry integration (set `SENTRY_DSN`)
- OpenTelemetry tracing (set `OTEL_EXPORTER_OTLP_ENDPOINT`)
- Circuit breakers on: Claude API, Twilio, Retell, Telegram, Cal.com

## Dashboard

React + Vite SPA served from `/public/`. 12 pages:

| Route | Page |
|-------|------|
| `/` | Dashboard (overview stats) |
| `/calls` | Call history + transcripts |
| `/messages` | SMS conversation log |
| `/pipeline` | Lead pipeline by stage |
| `/intelligence` | Analytics + insights |
| `/outreach` | Email campaign management |
| `/clients` | Client list (admin) |
| `/provision` | Provision new client (admin) |
| `/bookings` | Cal.com bookings view |
| `/settings` | Client settings |
| `/onboard` | Onboarding wizard |

## Scheduled Jobs

| Time | Job | Purpose |
|------|-----|---------|
| 3 AM | Data retention | Cleanup old jobs, logs |
| 6 AM | Lead scoring | Batch score all active leads |
| 9 AM | Lead review | Brain reviews each lead, takes actions |
| 10 AM | Outreach | Cold email batch send |
| 7 PM | Daily summary | Telegram digest to all clients |
| Monday 8 AM | Weekly report | AI-generated weekly report to all clients |
| Every 2 min | Appointment reminders | Check and send due reminders |
| Every 5 min | Follow-up processor | Process due follow-up touchpoints |
| Every 30 min | Reply checker | Check IMAP for email replies |

## Onboarding Steps

7-step wizard tracked per-client:

1. **Business info** — Set business name + industry
2. **Phone number** — Connect Twilio/Telnyx number
3. **Voice agent** — Configure Retell AI agent (per-client voice selection)
4. **Notifications** — Connect Telegram bot
5. **Booking** — Set Cal.com booking link
6. **Review link** — Add Google review link
7. **Test call** — Make a test call to verify

Progress auto-detected from configured fields. Initialized to step 0 on signup.

## Project Structure

```
server/bridge/
  config/
    routes.js          # All route mounts + middleware
    startup.js         # Server initialization
    timing.js          # Timeouts, intervals, limits
    middleware.js       # Helmet, CORS, logging, body parsing
  routes/
    auth/              # Signup, login, JWT, email verification
    api/               # REST API (18 sub-routers)
      stats.js         # Analytics + ROI proof
      leads.js         # Lead CRUD + scoring
      calls.js         # Call history
      messages.js      # SMS history
      clients.js       # Client CRUD
      reports.js       # Weekly reports + AI insights
      intelligence.js  # Conversation intelligence
      scoring.js       # Lead scoring API
      revenue.js       # Revenue funnel + cohorts
      bookings.js      # Cal.com bookings
      schedule.js      # Appointment scheduling
      exports.js       # CRM export (CSV/JSON)
      usage.js         # Usage metering + onboarding + plan upgrade
      settings.js      # Client settings API
      referral.js      # Referral program
      reseller.js      # White-label reseller
      calculator.js    # ROI calculator (public)
      chat.js          # Chat endpoint
    retell/            # Retell AI voice webhooks
    telegram/          # Telegram bot commands + callbacks
    whatsapp.js        # WhatsApp webhook
    social.js          # Facebook Messenger + Instagram DM
    calcom-webhook.js  # Cal.com booking webhooks
    billing.js         # Stripe billing
    onboard.js         # Client onboarding
    provision.js       # Admin provisioning
    forms.js           # Website form webhook
    outreach.js        # Cold email outreach
    tracking.js        # Email open/click tracking
  utils/
    brain.js           # AI decision engine (Claude)
    sms.js             # SMS sending (Twilio)
    telegram.js        # Telegram API + formatters
    calcom.js          # Cal.com API
    resilience.js      # Circuit breaker, retry, timeout
    jobQueue.js        # Persistent job queue
    jobHandlers.js     # Job type registry
    usageTracker.js    # Per-client usage recording
    migrations.js      # 39 database migrations
    scoring/           # Lead scoring engine
    templates/         # 12 industry niche templates
    eventStore.js      # Event sourcing
    encryption.js      # AES-256 PII encryption
    rateLimiter.js     # Bounded rate limiter
    kbCache.js         # Knowledge base LRU cache
    metrics.js         # In-memory metrics + alerting
  jobs/
    handlers/          # Job handler implementations
  dashboard/           # React + Vite frontend
  public/              # Static files (landing, demo, embed.js)
```
