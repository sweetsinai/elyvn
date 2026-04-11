# ELYVN — Claude Code Context

> This file encodes all architectural decisions, conventions, and gotchas so future sessions don't re-learn them. Read this first, always.

## What is ELYVN

AI receptionist platform for service businesses. Answers calls via Retell AI, sends SMS via Twilio, scores leads, books appointments via Cal.com, sends cold outreach emails, and gives the business owner a real-time Telegram + web dashboard.

**Stack:** Node.js 20 + Express + SQLite (better-sqlite3 WAL) + React 18 (Vite) + Railway deployment.

**AI:** Anthropic Claude Sonnet 4.6 (`@anthropic-ai/sdk` v0.87). Multi-agent system (feature-flagged, `ELYVN_MANAGED_AGENTS=true`).

## Repository Layout

```
elyvn/
  server/bridge/          ← Express API (the brain)
    index.js              ← Entry point (DO NOT await initializeDatabase — it's async by design)
    config/
      routes.js           ← Route mounting, health check, auth middleware
      middleware.js        ← Helmet, CORS, body parser, CSRF
      startup.js          ← DB init, env validation, scheduler, graceful shutdown
      timing.js           ← All timeout/interval constants
    routes/
      api/                ← 22 route modules (index.js barrel export)
      retell/             ← Retell webhook + call brain
      telegram/           ← Bot commands, callbacks, two-way SMS reply
      auth/               ← JWT + email magic link auth
      billing/            ← Stripe webhooks
      ...
    utils/
      brain.js            ← AI decision engine (single-call + multi-agent paths)
      agents/             ← Multi-agent system (index.js, orchestrator.js)
      scoring/            ← Lead scoring model (model.js, factors.js, weights.js)
      dbAdapter.js        ← SQLite/Postgres abstraction
      migrations.js       ← 41 migrations with down() functions
      sms.js              ← Twilio SMS sender
      telegram.js         ← Telegram Bot API client
      encryption.js       ← AES-256-GCM for PII columns
      ...
    tests/                ← 85 test files, 2409 tests
  dashboard/              ← React 18 SPA (Vite), builds into server/bridge/public/
    src/pages/            ← 12 pages (Dashboard, Clients, Calls, Messages, etc.)
  Dockerfile              ← Multi-stage (builder + runtime), runs as root (Railway constraint)
  railway.toml            ← Dockerfile builder, healthcheck /health, 300s timeout
```

## Critical Gotchas (read these or waste hours)

### 1. initializeDatabase is async but NOT awaited

`index.js:37` calls `initializeDatabase(app)` without `await`. This is intentional — the server starts listening immediately while migrations run in background. `mountRoutes()` must use **lazy db getters** (`const getDb = () => app.locals.db`), never capture `app.locals.db` at setup time.

### 2. SQLite PRAGMA foreign_keys = OFF is a no-op inside a transaction

`dbAdapter.js` runs migrations with FK checks disabled OUTSIDE the transaction:
```js
db.pragma('foreign_keys = OFF');
runMigrations(db);
db.pragma('foreign_keys = ON');
```
Never move FK pragmas inside `db.transaction()` — they silently do nothing.

### 3. Railway volume ownership

Railway mounts `/data` volume as root AFTER container start. A non-root Docker user cannot write `/data/elyvn.db`. We run as root deliberately. This is documented in the Dockerfile.

### 4. db.query() is the async interface

`better-sqlite3` is synchronous. `db.query(sql, params, mode)` wraps it in Promises so the same code works with both SQLite and Postgres (via `supabaseAdapter.js`). Always use `await db.query()` in route handlers.

### 5. Test environment variables

```bash
NODE_ENV=test ANTHROPIC_API_KEY=test-key JWT_SECRET=test-jwt-secret-that-is-at-least-32-chars ENCRYPTION_KEY=test-encryption-key-at-least-32-chars-long ELYVN_API_KEY=test-api-key RETELL_WEBHOOK_SECRET=test-retell-secret-for-ci TWILIO_AUTH_TOKEN=test-twilio-auth-token-for-ci TWILIO_ACCOUNT_SID=ACtest123456789 STRIPE_WEBHOOK_SECRET=whsec_test_stripe_secret_for_ci TELEGRAM_WEBHOOK_SECRET=test-telegram-secret-for-ci npx jest --forceExit --passWithNoTests --no-coverage
```

### 6. Migration authoring rules

- Always add a `down()` function (even if it's a no-op with a comment for SQLite ALTER TABLE limitations)
- Use `rebuildTable()` helper for table restructuring — it introspects columns dynamically
- Test with `npx jest tests/migrations.test.js` after adding a migration
- Migration IDs are zero-padded strings: `'042_my_migration'`

## Coding Conventions

### Error handling
- Use `AppError(code, message, statusCode)` for all route errors
- Validation errors → status 422, code `VALIDATION_ERROR`
- All error responses: `{ code, message, requestId }`
- Rate limit 429s include `{ code: 'RATE_LIMIT_EXCEEDED', message, requestId }`

### Route patterns
- `validateParams(ClientParamsSchema)` middleware on all `:clientId` routes
- `validateBody(Schema)` middleware on all POST/PUT bodies
- `success(res, data)` helper for all 200 responses
- `clientIsolationParam` on `router.param('clientId', ...)` for tenant isolation

### AI/ML patterns
- All Claude JSON output validated with Zod `.safeParse()` after `JSON.parse()`
- All user data sanitized before prompt interpolation (`sanitizeForPrompt()`, `deepSanitizeEventData()`, `sanitizeTranscript()`)
- Scoring model: `Math.max(0, Math.min(100, Math.round(...)))` — always clamp
- Weights must sum to 1.0 — runtime assertion at module load
- Default model: `claude-sonnet-4-6` (set in `utils/config.js`)

### Security
- Telegram webhook: fixed 256-byte `Buffer.alloc` timing-safe comparison
- SQL: field allowlist Set for dynamic UPDATE columns
- Helmet with CSP + HSTS (config/middleware.js)
- AES-256-GCM encryption for PII (phone_encrypted, email_encrypted)
- ENCRYPTION_KEY hard-fails in production if missing

## Phone Number Architecture (UNIFIED — Phase 1 complete)

| Field | Purpose | Status |
|---|---|---|
| `phone_number` | **Unified number** — calls + SMS, single Twilio number with SIP trunk to Retell | ACTIVE |
| `retell_phone` | Legacy inbound calls field | DEPRECATED (kept for backward compat) |
| `twilio_phone` | Legacy outbound SMS field | DEPRECATED (kept for backward compat) |
| `telnyx_phone` | Legacy alternative SMS (migration 020) | DEPRECATED |
| `transfer_phone` | Call forwarding destination | UNUSED (Phase 2) |
| `owner_phone` | Business owner's personal phone | ACTIVE |

**Migration 042** added `phone_number` and backfilled from `COALESCE(twilio_phone, retell_phone)`.
All runtime code now uses `phone_number` exclusively. Legacy columns remain for data preservation.
`utils/twilioProvisioning.js` provides SIP trunk + number purchase API (Twilio REST, no SDK).

## Call Transfer (Phase 2 — IMPLEMENTED)

`transfer_phone` in clients table. `handleTransfer()` in `routes/retell/followups.js` implements a 3-step cascade:
1. **Warm transfer**: Retell API `POST /v2/transfer-call/{call_id}` with AI-generated summary as intro
2. **Cold transfer**: Twilio REST API updates the call with inline TwiML (`<Dial timeout="30">` to transfer_phone)
3. **Fallback**: SMS + Telegram notification to owner with "call them back ASAP" urgency

`utils/callTransfer.js` — circuit-breaker-protected Retell and Twilio transfer functions.
Triggered by: `agent_transfer`, `transfer_requested`, `dtmf` (star key) webhook events.
Dashboard Settings page shows and edits `transfer_phone` per client.

## Webhook / External Data Push

`utils/webhookQueue.js` exists with full retry infrastructure (HMAC-SHA256, exponential backoff, 5 retries). But no pre-built integrations for Google Sheets, Zapier, Slack, etc. The queue fires on custom client webhook URLs.

**Plan:** Add structured webhook events (`call_ended`, `lead_created`, `booking_confirmed`, `lead_stage_changed`) that fire to client-configured webhook URLs. Clients connect these to Sheets/Slack/CRM via Zapier/Make.

## Multi-Agent System

Feature-flagged behind `ELYVN_MANAGED_AGENTS=true` (disabled by default).

| Agent | Purpose |
|---|---|
| Receptionist | Event analysis → action decisions |
| Outreach | Cold email composition + A/B subjects |
| Qualification | Reply classification + lead scoring |
| Scheduling | Follow-up timing + channel optimization |

Pipelines: `newLeadPipeline`, `replyPipeline`, `outreachPipeline`, `scoringPipeline`.
Falls back to legacy single-call brain.js when disabled or on failure.

## Dashboard Pages (React 18 + Vite) — NEEDS FULL REDESIGN

Current pages (all .jsx, inline styles): Dashboard, Clients, ClientDetail, Calls, Messages, Bookings, Pipeline, Intelligence, Settings, Outreach, Onboard, Provision, Integrations.

### IMMEDIATE NEXT TASK: Full Dashboard Redesign

The dashboard is functional but visually bare. Redesign to match the website's premium gold/black brand:

**Design system (from website/index.html + Morpheus reference):**
- Primary gold: `#D4AF37` (not `#C9A84C`)
- Background: `#050505` (primary), `#111111` (cards)
- Card borders: `rgba(212, 175, 55, 0.15)` (gold tint)
- Fonts: Cormorant Garamond for headlines, Inter for body
- Inputs: `#0a0a0a` background, gold border on focus `rgba(212,175,55,0.4)`
- Buttons: gold gradient, shimmer on hover
- Gold glow effects on hover: `box-shadow: 0 0 20px rgba(212,175,55,0.15)`

**Pages to build (13 total):**
1. `/login` — Premium login with gold branding, dark card, signup toggle
2. `/` — Dashboard Overview: KPI cards (calls today, leads, bookings, revenue), quick actions, system status
3. `/calls` — Call log table with transcript viewer + download button
4. `/messages` — Unified inbox (SMS + email), conversation threads
5. `/pipeline` — Lead pipeline board (Kanban stages or list)
6. `/intelligence` — AI insights, coaching tips, peak hours
7. `/outreach` — Cold email campaigns, prospect scraping
8. `/clients` — Client list (admin view)
9. `/client/:clientId` — Single client detail
10. `/bookings` — Appointment calendar/list
11. `/settings` — Client settings (transfer phone, webhook URLs, Google Sheet ID)
12. `/integrations` — Service status, webhook log, test button
13. `/provision` — Admin client provisioning form

**Sidebar:** 260px fixed, 3 sections (Core, Management, Intelligence), gold active states, user email + logout at bottom.

**Reference:** The Morpheus admin dashboard (`/Users/sohangowda/morpheus/morpheus-admin/src/`) uses the same design system — gold borders, dark cards, Cormorant headers. Use it as direct reference for component patterns.

**Added in Phase 4:** Integrations page (webhook log, test button, Sheets guide), unified phone number display in Settings, real-time active call indicators + transfer controls in Calls.

**Added in Phase 5:** Messages page rewritten as unified inbox — conversation list with unread badges, unified timeline (SMS + calls merged), two-way SMS compose bar, delivery status icons, archive controls.

## Deployment

- **Railway** (`joyful-trust`): Dockerfile builder, `/data` volume for SQLite, healthcheck `/health` with 300s timeout
- **GitHub CI**: Jest tests + security scans + build + Railway auto-deploy on push, all 2409 passing
- Deploy: `cd elyvn && railway up` (or push to main for auto-deploy)
- Env vars: managed via `railway variables set KEY=VALUE`

## Audit Scores (2026-04-10, real code-read audits)

| Category | Score |
|---|---|
| Security | 8.5/10 |
| AI/ML | 9.7/10 |
| API Quality | 9/10 |
| Reliability | 10/10 |
| Test/DevOps | 9.5/10 |

Remaining gaps: sanitizers don't strip semantic prompt delimiters (`Human:`, `---`), autoClassify 2-phase write not transactional, coverage branch threshold 50%.

## Implementation Plan — Next Features

### Phase 1: Unified Phone Number (DONE)
- [x] Migration 042: `phone_number` column + backfill from `COALESCE(twilio_phone, retell_phone)`
- [x] All lookups (calls.js, handlers.js, sms.js, telegram, social, calcom, speed-to-lead, actionExecutor, appointmentReminders) use `phone_number`
- [x] `utils/twilioProvisioning.js`: search, purchase, SIP trunk, origination URI, number-trunk association
- [x] Provision route sets `phone_number` for new clients
- [x] Dashboard shows `phone_number` in provisioning success
- [x] Settings API exposes `phone_number` in response
- [x] 2320 tests passing (5 pre-existing scheduler timeouts)

### Phase 2: Call Transfer (DONE)
- [x] `utils/callTransfer.js`: warm transfer via Retell `POST /v2/transfer-call/{call_id}`, cold transfer via Twilio inline TwiML
- [x] `handleTransfer()` rewritten with 3-step cascade: warm → cold → fallback (voicemail + Telegram/SMS)
- [x] Fixed `calls.js` re-export of `handleTransfer` (was `undefined` — webhook events were silently failing)
- [x] Cold transfer uses inline TwiML with `<Dial timeout="30">` + `<Record>` voicemail fallback
- [x] `notifyTransferSuccess()` + `notifyTransferFallback()` — SMS + Telegram alerts to owner
- [x] Dashboard Settings: `transfer_phone` field (edit + display with PhoneForwarded icon)
- [x] `timing.js`: `TRANSFER_DIAL_TIMEOUT_S: 30`, `TRANSFER_VOICEMAIL_MAX_LENGTH_S: 120`
- [x] Settings API already had `transfer_phone` in ALLOWED whitelist (no changes needed)
- [x] 17 new tests in `callTransfer.test.js` — warm, cold, fallback, edge cases
- [x] 2342 tests passing (commit 6a3b48a)

### Phase 3: Webhook Events + Google Sheets (DONE)
- [x] Migration 043: `lead_webhook_url`, `call_webhook_url`, `sms_webhook_url`, `stage_change_webhook_url` columns on clients (`booking_webhook_url` from 038)
- [x] `utils/webhookEvents.js`: centralized helpers — `fireCallEnded`, `fireLeadStageChanged`, `fireSmsReceived`, `fireSmsSent`
- [x] Event schema: `{ event, clientId, timestamp, data }` with HMAC-SHA256 signing via `webhookQueue.js`
- [x] Webhooks fire on: `call_ended` (retell/calls.js), `lead.stage_changed` (leads.js PUT), `sms.received` + `sms.sent` (normalMessage.js)
- [x] Pre-existing: `lead.created` (forms.js), `booking.created` (calcom-webhook.js)
- [x] Settings API: webhook URLs in GET response (`webhooks` category) + PUT ALLOWED set
- [x] Clients API: `CLIENT_SAFE_COLS` + `ALLOWED_CLIENT_FIELDS` updated for webhook columns
- [x] Dashboard Settings: webhook URL edit fields per client + "Data Export" section with CSV download links
- [x] `GET /api/exports/:clientId/sheets`: combined leads + calls + messages export (CSV + JSON)
- [x] 17 new tests in `webhookEvents.test.js` — event helpers, migration, settings, export
- [x] 2359 tests passing (83 suites)

### Phase 4: Dashboard Upgrade (DONE)
- [x] Settings: unified phone number display (phone_number, transfer_phone, voice config from /api/settings)
- [x] Settings: already had webhook URL config + transfer_phone editing (Phase 3)
- [x] Calls: real-time active call indicators via `call_started` WebSocket event (green pulsing banner)
- [x] Calls: transfer controls — button on active calls + button in call detail modal
- [x] `POST /api/calls/:clientId/:callId/transfer` — warm transfer via Retell, cold fallback via Twilio
- [x] New page: Integrations (`/integrations`) — service status grid, inbound/outbound webhook URLs, test webhook button, delivery log table, Google Sheets setup guide (Zapier + Make + CSV)
- [x] `GET /api/integrations/:clientId/webhook-log` — filtered delivery log from webhook queue
- [x] `POST /api/integrations/:clientId/webhook-test` — send test event to configured URL
- [x] `GET /api/integrations/:clientId/status` — aggregated integration status
- [x] WebSocket: `call_started` broadcast on call begin (retell/calls.js handleCallStarted)
- [x] WebSocket: `call_transfer` broadcast on transfer (retell/followups.js handleTransfer)
- [x] WebSocket: existing `new_call` broadcast on call end (Phase 2) removes call from active list
- [x] Sidebar: Integrations nav item (Webhook icon) between Provision and Settings
- [x] 12 new tests in `integrations.test.js` — webhook log filtering, test payload, transfer cascade, WS events
- [x] 2371 tests passing (84 suites)

### Phase 5: Messaging Unification (DONE)
- [x] Migration 044: `conversations` table (id, client_id, lead_id, lead_phone, lead_name, last_message_at, last_message_preview, unread_count, status) with UNIQUE(client_id, lead_phone)
- [x] Migration 044: `conversation_id`, `delivery_status`, `delivered_at`, `read_at` columns on messages table
- [x] Migration 044: Backfill — existing messages grouped by (client_id, phone) create conversations, all messages linked
- [x] `routes/api/conversations.js`: 5 endpoints — list, timeline, send, mark-read, archive
- [x] `GET /conversations/:clientId` — inbox view with search, status filter, lead score/stage join, sorted by last_message_at
- [x] `GET /conversations/:clientId/:conversationId/timeline` — unified timeline merging messages + calls sorted chronologically
- [x] `POST /conversations/:clientId/:conversationId/send` — two-way SMS from dashboard (sendSMS + record + WS broadcast + webhook)
- [x] `PUT /conversations/:clientId/:conversationId/read` — mark inbound messages as read, reset unread_count
- [x] `PUT /conversations/:clientId/:conversationId/archive` — archive conversation
- [x] `normalMessage.js` updated: `ensureConversation()` creates/updates conversations on every inbound SMS (all 3 paths: normal, rate-limited, AI-paused)
- [x] Outbound messages record `conversation_id`, `delivery_status`, conversation preview updated on send
- [x] WebSocket broadcasts include `conversationId` field for targeted UI updates
- [x] Dashboard Messages page: full rewrite — conversation list (left), unified timeline with call bubbles (right), compose bar with Enter-to-send, delivery status icons (sent/delivered/read/failed), unread badges, archive controls
- [x] Validation schemas: `ConversationQuerySchema`, `ConversationDetailParamsSchema`, `SendMessageBodySchema` with XSS-safe safeString + min(1)
- [x] 38 new tests in `conversations.test.js` — schema validation, timeline merge, delivery status, read receipts, send flow, backfill logic
- [x] GitHub CI/CD: enhanced with Railway auto-deploy job, SQL injection pattern scan, OWASP dep check, healthcheck verification
- [x] 2409 tests passing (85 suites)

## Session Workflow for Future Claude Code Sessions

Each session reads this CLAUDE.md first, picks up one phase, and executes it:

1. Read CLAUDE.md + understand the phase scope
2. Write implementation plan as tasks
3. Execute: migrations → routes → tests → dashboard (in order)
4. Run full test suite: all 2325+ must pass
5. Commit with descriptive message
6. Push to GitHub + deploy to Railway
7. Verify healthcheck green
8. Update this CLAUDE.md with any new decisions or gotchas
