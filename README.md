# ELYVN

AI receptionist for service businesses. Answers calls 24/7, books appointments, sends SMS follow-ups, notifies owners via Telegram, and logs everything to Google Sheets.

**Live:** [https://api.elyvn.net](https://api.elyvn.net)
**Website:** [https://elyvn.net](https://elyvn.net)

---

## What It Does

1. **AI Voice Receptionist:** Pick up calls 24/7, answer questions, and book appointments via Cal.com using Retell AI.
2. **Unified Messaging:** Combined inbox for SMS and Email with two-way messaging from the dashboard.
3. **Lead Management:** Predictive lead scoring (0-100) and Kanban pipeline tracking.
4. **Call Transfer:** Intelligent 3-step cascade (Warm transfer → Cold transfer → Fallback to SMS/Telegram).
5. **Real-time Notifications:** Owners get instant Telegram alerts for calls, bookings, and important lead activities.
6. **Automated Logging:** All activities are logged to Google Sheets and the unified dashboard.
7. **Multi-Agent System:** Feature-flagged autonomous agents for Reception, Outreach, Qualification, and Scheduling.

## Tech Stack

- **Backend:** Node.js 20, Express, SQLite (better-sqlite3 WAL mode) with PostgreSQL support via Supabase adapter.
- **Frontend:** React 18, Vite (built into `server/bridge/public/`).
- **AI:** Anthropic Claude Sonnet 4.6 via `@anthropic-ai/sdk`.
- **Voice:** Retell AI for high-quality voice agents and call handling.
- **SMS/Phone:** Twilio for unified phone numbers (Calls + SMS), SIP trunking, and number provisioning.
- **Payments:** Dodo Payments for subscription billing (Solo/Starter/Pro/Premium).
- **Booking:** Cal.com integration for automated appointment scheduling.
- **Notifications:** Telegram Bot API for real-time alerts and remote commands.
- **Monitoring:** Sentry, OpenTelemetry, Prometheus metrics.
- **Hosting:** Railway (Docker multi-stage build, SQLite volume at `/data`).

## Repository Structure

```
elyvn/
  server/bridge/           <- Express API Server
    index.js               <- Entry point (async DB init)
    config/
      routes.js            <- Route mounting and auth middleware
      startup.js           <- DB init, schedulers, and graceful shutdown
      middleware.js        <- Security, CORS, and body parsing
      timing.js            <- Timeout and interval constants
    routes/
      api/                 <- REST endpoints (clients, calls, leads, conversations, etc.)
      retell/              <- Retell AI webhook and call logic
      telegram/            <- Telegram bot commands and SMS replies
      auth/                <- JWT authentication and magic links
      billing/             <- Dodo Payments integration
    utils/
      brain.js             <- AI decision engine (single-call and multi-agent paths)
      agents/              <- Multi-agent system orchestration
      scoring/             <- Predictive lead scoring model
      validators.js        <- Centralized input validation and sanitization
      sms.js               <- Twilio SMS integration
      telegram.js          <- Telegram Bot client
      encryption.js        <- AES-256-GCM for sensitive data
      migrations.js        <- 80+ database migrations with rollback support
    tests/                 <- 85+ test files, 2400+ tests
  dashboard/               <- React 18 SPA (Vite)
    src/pages/             <- 13 dashboard pages (Dashboard, Pipeline, Messages, etc.)
  Dockerfile               <- Multi-stage production build
  railway.toml             <- Railway deployment configuration
  CLAUDE.md                <- Technical context and conventions for developers
```

## How to Run Locally

```bash
# 1. Install dependencies
cd server/bridge && npm install
cd ../../dashboard && npm install

# 2. Set environment variables
cp server/bridge/.env.example server/bridge/.env
# Edit .env with your credentials

# 3. Start the server
cd server/bridge && npm start

# 4. Start the dashboard (development mode)
cd dashboard && npm run dev
```

## Environment Variables (Required)

See `server/bridge/.env.example` for the full list. Key variables include:
- `ANTHROPIC_API_KEY`: For Claude AI.
- `RETELL_API_KEY`: For voice agents.
- `TWILIO_ACCOUNT_SID` & `TWILIO_AUTH_TOKEN`: For SMS and phone numbers.
- `DODO_API_KEY` & `DODO_WEBHOOK_SECRET`: For payments.
- `TELEGRAM_BOT_TOKEN`: For the notification bot.
- `DATABASE_PATH`: Path to the SQLite database file.
- `ENCRYPTION_KEY`: 32-byte key for PII encryption.

## Client Onboarding

### Automated Provisioning (`POST /api/provision`)
The preferred method for admin-led onboarding. It automatically:
1. Creates a Retell AI agent and LLM.
2. Purchases a dedicated Twilio phone number.
3. Sets up a SIP trunk to connect Twilio to Retell.
4. Creates the client record and knowledge base.
5. Returns a Telegram onboarding link for the client.

### Standard Onboarding (`POST /api/onboard`)
Creates a client record and generates a baseline knowledge base JSON for manual integration steps.

## API & Webhooks

All API routes under `/api/` require authentication via JWT Bearer token or `x-api-key`.

### Key Endpoints
- `GET /api/conversations/:clientId`: Unified inbox for SMS and calls.
- `POST /api/calls/:clientId/:callId/transfer`: Manual call transfer trigger.
- `GET /api/integrations/:clientId/status`: Check status of external services.

### Inbound Webhooks
- `/webhooks/retell`: Call status and transcript events.
- `/webhooks/twilio`: Inbound SMS messages.
- `/webhooks/telegram`: Bot commands and user interactions.
- `/webhooks/calcom`: Booking confirmations.

## Deployment

ELYVN is designed to run on **Railway** with a persistent volume for the SQLite database.
- Deploy via CLI: `railway up`
- Auto-deploy: Push to the `main` branch.
- Health Check: `GET /health` (monitored by Railway).

## Testing

We maintain a high test coverage with over 2400 tests.
```bash
cd server/bridge
npm test
```

## Developer Guidelines

1. **Read CLAUDE.md** before starting any work.
2. **Database migrations** must always include a `down()` function.
3. **Input validation** should use the centralized `utils/validators.js`.
4. **AI interactions** must be sanitized and validated using Zod schemas.
5. **Security**: Never log PII; use the `encrypt()` helper for phone numbers and emails in the database.
