# ELYVN

AI receptionist for service businesses. Answers calls 24/7, books appointments, sends SMS follow-ups, notifies owners via Telegram, logs everything to Google Sheets.

**Live:** https://api.elyvn.net
**Website:** https://elyvn.net

---

## What It Does

1. Customer calls the ELYVN phone number
2. AI picks up, answers questions, books appointments via Cal.com
3. If customer asks for the owner, AI transfers the call
4. After the call, owner gets a Telegram notification with summary
5. Call details auto-log to Google Sheets
6. Missed calls get an SMS text-back within 30 seconds

## Tech Stack

- **Backend:** Node.js 20, Express, SQLite (better-sqlite3 WAL mode)
- **Frontend:** React 18, Vite (builds into server/bridge/public/)
- **AI:** Claude Sonnet 4.6 via Anthropic SDK
- **Voice:** Retell AI (creates AI agents, handles calls)
- **SMS:** Twilio (outbound SMS, inbound webhooks)
- **Payments:** Dodo Payments (Indian-friendly, replaces Stripe)
- **Booking:** Cal.com (free plan, books appointments)
- **Notifications:** Telegram Bot (@ELYVNupdatebot)
- **Logging:** Google Sheets (auto-logs calls, bookings, messages)
- **Hosting:** Railway (Docker, SQLite volume at /data)
- **CI/CD:** GitHub Actions (tests on push, auto-deploy)

## Repository Structure

```
elyvn/
  server/bridge/           <- Main Express server
    index.js               <- Entry point
    config/
      routes.js            <- All route mounting + auth middleware
      startup.js           <- DB init, schedulers, graceful shutdown
      middleware.js         <- Helmet, CORS, CSRF, body parser
      timing.js            <- All timeout/interval constants
    routes/
      api/                 <- 22 REST endpoints (clients, calls, leads, etc.)
      retell/              <- Retell webhook handler (call events)
      telegram/            <- Telegram bot commands + callbacks
      auth/                <- JWT login/signup + email verification
      billing.js           <- Dodo Payments checkout + webhooks
    utils/
      brain.js             <- AI decision engine (what to do after each event)
      agents/              <- Multi-agent system (receptionist, outreach, etc.)
      scoring/             <- Lead scoring model (factors, weights, clamping)
      googleSheets.js      <- Write to client Google Sheets
      sms.js               <- Twilio SMS sending
      telegram.js          <- Telegram Bot API client
      encryption.js        <- AES-256-GCM for PII
      migrations.js        <- 51 database migrations
      dbAdapter.js         <- SQLite/Postgres abstraction
    tests/                 <- 85 test files, 2400+ tests
  dashboard/               <- React SPA (Vite)
    src/pages/             <- 13 pages (Dashboard, Calls, Messages, etc.)
  website/                 <- Marketing site (static HTML)
  landing/                 <- Landing page
  Dockerfile               <- Multi-stage Docker build
  railway.toml             <- Railway deployment config
  CLAUDE.md                <- Full architecture doc for AI sessions
```

## How to Run Locally

```bash
# Install dependencies
cd server/bridge && npm install
cd ../../dashboard && npm install

# Set environment variables (copy and fill in)
cp server/bridge/.env.example server/bridge/.env

# Run the server
cd server/bridge && node index.js

# Build dashboard (optional — for production)
cd dashboard && npx vite build
```

## Environment Variables (Required)

```
# Core
NODE_ENV=production
PORT=3001
JWT_SECRET=<at-least-32-chars>
ENCRYPTION_KEY=<64-hex-chars>
DATABASE_PATH=/data/elyvn.db

# AI
ANTHROPIC_API_KEY=<from anthropic.com>

# Voice (Retell)
RETELL_API_KEY=<from retellai.com>

# SMS (Twilio) — MUST upgrade from trial for real SMS
TWILIO_ACCOUNT_SID=<from twilio.com>
TWILIO_AUTH_TOKEN=<from twilio.com>

# Payments (Dodo)
DODO_API_KEY=<from dodopayments.com>
DODO_WEBHOOK_SECRET=<from dodo webhook settings>
DODO_PRODUCT_SOLO=pdt_0NcSVPcrrPE9CjPnCdjJC
DODO_PRODUCT_STARTER=pdt_0NcSMDfAgPfJcHnUH1H4l
DODO_PRODUCT_PRO=pdt_0NcSLxjRSsPJST0uTn8kN
DODO_PRODUCT_PREMIUM=pdt_0NcSMTlJqIJcQsneYDYsi

# Booking
CALCOM_API_KEY=<from cal.com>
CALCOM_BOOKING_LINK=https://cal.com/elyvn/quick

# Telegram
TELEGRAM_BOT_TOKEN=<from @BotFather>
TELEGRAM_WEBHOOK_SECRET=<random-hex>
TELEGRAM_ADMIN_CHAT_ID=<your telegram user id>

# Google Sheets
GOOGLE_SERVICE_ACCOUNT_JSON=<paste full JSON from GCP>

# Email (SMTP for verification emails + cold outreach)
SMTP_HOST=<smtp server>
SMTP_USER=<email>
SMTP_PASS=<password>

# Railway
RAILWAY_PUBLIC_DOMAIN=api.elyvn.net
APP_URL=https://api.elyvn.net
CORS_ORIGINS=https://api.elyvn.net
```

## Pricing Plans (Dodo Payments)

| Plan | Price | Calls/mo | SMS/mo | Emails/mo |
|------|-------|----------|--------|-----------|
| Solo | $99 | 100 | 300 | 100 |
| Starter | $199 | 500 | 1,000 | 200 |
| Pro | $399 | 1,500 | 3,000 | 500 |
| Premium | $799 | Unlimited | Unlimited | Unlimited |

Solo plan has 7-day free trial.

## How Client Onboarding Works

### What you do (admin):
1. Hit `POST /api/provision` with business details + knowledge base
2. System auto-creates: Retell AI agent, buys Twilio number, sets up SIP trunk, saves to DB, creates Google Sheet, generates Telegram link
3. Give client: their phone number + Telegram link

### What the client does:
1. Clicks Telegram link -> bot connects to their account
2. Forwards unanswered calls to their ELYVN number
3. Done. Calls get answered, they get Telegram alerts.

### Client gets:
- Telegram notifications for every call (summary, score, outcome)
- Google Sheet with call/booking/SMS log (if they share a sheet)
- Cal.com bookings on their calendar
- Dashboard at api.elyvn.net (login with email/password)

## Telegram Bot Commands

| Command | What it does |
|---------|-------------|
| /status | Full dashboard — calls, leads, revenue |
| /calls | Recent calls list |
| /leads | Active leads by stage |
| /ask | Ask AI about your business data |
| /today | Today's schedule |
| /stats | Last 7 days stats |
| /brain | AI Brain activity feed |
| /pause | Pause AI answering |
| /resume | Resume AI answering |
| /help | Show all commands |

## API Endpoints

All API routes under `/api/` require authentication (JWT Bearer token or x-api-key header).

### Auth
- `POST /auth/signup` — Create account
- `POST /auth/login` — Login, get JWT token
- `GET /auth/me` — Current user info

### Clients
- `GET /api/clients` — List all clients
- `PUT /api/clients/:id` — Update client settings

### Calls
- `GET /api/calls/:clientId` — Call history
- `GET /api/calls/:clientId/:callId/transcript` — Get transcript
- `GET /api/calls/:clientId/:callId/transcript/download` — Download as .txt

### Leads
- `GET /api/leads/:clientId` — Lead list
- `PUT /api/leads/:clientId/:leadId` — Update lead stage/score

### Billing
- `GET /billing/plans` — List plans
- `POST /billing/create-checkout` — Create Dodo checkout URL
- `GET /billing/status` — Current billing status

### Webhooks (inbound from external services)
- `POST /webhooks/retell` — Retell call events
- `POST /webhooks/twilio` — Twilio SMS events
- `POST /webhooks/telegram` — Telegram bot updates
- `POST /webhooks/calcom` — Cal.com booking events
- `POST /billing/webhook` — Dodo payment events

## Known Issues (MUST FIX)

### Critical: Missing database columns
The production SQLite DB is missing columns that the code expects. This causes `no such column` crashes on various features. **The next session MUST scan every SQL query in the codebase against the actual DB schema and add ALL missing columns in one migration.**

### Twilio trial limitations
- Can only send SMS to verified numbers
- Can only own 1 phone number
- **Fix:** Upgrade Twilio account ($20)

### Google Sheets
- Service accounts on free Gmail get 0 bytes Drive storage
- Cannot auto-create sheets
- **Workaround:** Client creates a Google Sheet, shares with `elyvn-bot@elyvn-491010.iam.gserviceaccount.com`, we store the sheet ID
- **Real fix:** Get Google Workspace ($7/mo) for elyvn.net domain

### Cal.com per client
- Currently using ONE Cal.com account (Sohan's) for all bookings
- Each client should have their own Cal.com account
- During onboarding, collect client's Cal.com API key + event type ID
- Store per-client in DB: `calcom_api_key`, `calcom_event_type_id`
- Retell agent tools use the client's own Cal.com credentials

## Deployment

```bash
# Deploy to Railway
cd elyvn && railway up

# Or push to GitHub (auto-deploys via CI)
git push origin main

# Set env vars
railway variables set KEY=VALUE

# Check logs
railway logs

# Check health
curl https://api.elyvn.net/health
```

## Running Tests

```bash
cd server/bridge
NODE_ENV=test \
ANTHROPIC_API_KEY=test-key \
JWT_SECRET=test-jwt-secret-that-is-at-least-32-chars \
ENCRYPTION_KEY=test-encryption-key-at-least-32-chars-long \
ELYVN_API_KEY=test-api-key \
RETELL_WEBHOOK_SECRET=test-retell-secret-for-ci \
TWILIO_AUTH_TOKEN=test-twilio-auth-token-for-ci \
TWILIO_ACCOUNT_SID=ACtest123456789 \
DODO_WEBHOOK_SECRET=whsec_test_dodo_secret \
TELEGRAM_WEBHOOK_SECRET=test-telegram-secret-for-ci \
npx jest --forceExit --passWithNoTests --no-coverage
```

## Key Accounts

| Service | URL | What it does |
|---------|-----|-------------|
| Railway | railway.app | Hosts the server + SQLite DB |
| Retell AI | retellai.com | Voice AI agents |
| Twilio | twilio.com | Phone numbers + SMS |
| Dodo Payments | dodopayments.com | Billing/subscriptions |
| Cal.com | cal.com | Appointment booking |
| Telegram | @ELYVNupdatebot | Client notifications |
| Google Cloud | console.cloud.google.com | Sheets API service account |
| GitHub | github.com/sweetsinai/elyvn | Source code + CI/CD |

## For the Next Developer

1. **Read CLAUDE.md first** — it has every architectural decision, gotcha, and convention
2. **The #1 priority is stability** — fix all missing DB columns before adding features
3. **Test against production DB schema** — don't assume columns exist just because migrations define them. The prod DB may be behind.
4. **initializeDatabase() is async but NOT awaited** in index.js — this is intentional. Use lazy getters (`getDb()` or `req.app.locals.db`) in route handlers, never capture `db` at module load time.
5. **Retell API has no /v2/ prefix** — endpoints are `POST /create-agent`, `GET /list-agents`, etc. at `api.retellai.com`
6. **Twilio is trial** — upgrade before testing SMS features
7. **Every client gets isolated data** — `clientIsolationParam` middleware enforces this on all routes
