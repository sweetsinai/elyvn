# ELYVN System Documentation

## What Is ELYVN

ELYVN is an AI receptionist SaaS for local service businesses (dental, HVAC, med spa, salons, gyms, real estate). It answers phone calls 24/7 via Retell AI, qualifies leads, books appointments via Cal.com, sends SMS follow-ups via Twilio/Telnyx, and gives business owners full control through a Telegram bot.

**Stack:** Node.js + Express + SQLite (better-sqlite3), deployed on Railway. React dashboard on the same server. Landing page on Vercel.

---

## Architecture Overview

```
                    ┌─────────────────────────────────────┐
                    │           ELYVN Backend              │
                    │     Railway (joyful-trust)           │
                    │     api.elyvn.net                    │
                    ├─────────────────────────────────────┤
   Retell AI ──────▶│  /retell    (voice call webhooks)   │
   Twilio   ──────▶│  /twilio    (SMS webhooks)          │
   Telnyx   ──────▶│  /telnyx    (SMS webhooks)          │
   Telegram ──────▶│  /webhooks/telegram (bot commands)  │
   Cal.com  ──────▶│  /calcom-webhook (bookings)         │
   Stripe   ──────▶│  /billing/webhook (payments)        │
   Browser  ──────▶│  /auth, /api, /billing (dashboard)  │
                    ├─────────────────────────────────────┤
                    │  BRAIN ENGINE (Claude API)           │
                    │  → Analyzes every event              │
                    │  → Decides: SMS, followup, notify,  │
                    │    book, score, stage change         │
                    │  → Max 3 auto-SMS/day per lead      │
                    ├─────────────────────────────────────┤
                    │  JOB QUEUE (SQLite, 15s interval)   │
                    │  → speed-to-lead sequences          │
                    │  → appointment reminders             │
                    │  → follow-up scheduling              │
                    │  → data retention cleanup            │
                    └─────────────────────────────────────┘
```

---

## Telegram Bot — Full Command Reference

### All Plans (Starter, Growth, Scale)

| Command | Description | Data Source |
|---------|-------------|-------------|
| `/start <clientId>` | Links Telegram to client account | clients table |
| `/status` | Full dashboard: today's calls, 7-day stats, leads, recent calls, AI status | calls, messages, leads, job_queue |
| `/today` | Today's + tomorrow's appointment schedule | appointments table |
| `/stats` | 7-day performance: calls, messages, revenue with week-over-week comparison | calls, messages, leads |
| `/leads` | Active leads grouped by stage (hot → booked → warm → new) with scores | leads table |
| `/calls` | Last 5 calls with transcripts (inline keyboard to view full transcript) | calls table |
| `/complete +phone` | Marks job done, cancels reminders, schedules review request in 2h | appointments, followups, leads |
| `/set key value` | Configure: review link, avg ticket, business name, transfer number | clients table |
| `/reviewlink [url]` | View or set Google review link (shortcut for /set review) | clients table |
| `/pause` | Pause AI — calls ring through to owner | clients.is_active |
| `/resume` | Resume AI answering | clients.is_active |
| `/help` | Dynamic command list based on plan | telegram.PLAN_COMMANDS |

### Pro + Premium Plans

| Command | Description | Data Source |
|---------|-------------|-------------|
| `/brain` | Last 10 AI Brain decisions with actions, reasoning, and 7-day count | audit_log (action='brain_decision') |

### Premium Plan Only

| Command | Description | Data Source |
|---------|-------------|-------------|
| `/outreach` | Campaign stats: sent, replies, positive, booked for last 5 campaigns | campaigns, emails_sent |
| `/scrape industry city` | Find prospects via Google Maps (triggers internal scrape API) | prospects table |
| `/prospects` | Top 10 prospects by rating/reviews | prospects, campaign_prospects |

### Inline Keyboard Actions (Callback Queries)

| Button | Callback Data | Action |
|--------|--------------|--------|
| Full transcript | `transcript:{callId}` | Sends transcript (or .txt file if >3500 chars) |
| Good reply | `msg_ok:{messageId}` | Acknowledges AI reply was correct |
| I'll handle this | `msg_takeover:{messageId}:{phone}` | Owner takes over conversation |
| Cancel sequence | `cancel_speed:{leadId}` | Cancels speed-to-lead jobs + followups |

### Real-Time Notifications (Pushed to Owner)

| Event | Format Function | Trigger |
|-------|----------------|---------|
| Call ended | `formatCallNotification()` | After every Retell call |
| Transfer request | `formatTransferAlert()` | Caller requests human |
| New SMS | `formatMessageNotification()` | Inbound SMS with AI reply |
| Escalation | `formatEscalation()` | AI unsure, needs human input |
| Booking confirmed | `formatBookingNotification()` | Cal.com webhook |
| Daily summary | `formatDailySummary()` | 7 PM daily (scheduled) |
| Weekly report | `formatWeeklyReport()` | Weekly (scheduled) |

---

## AI Brain Engine (utils/brain.js)

The Brain is called after every event: `call_ended`, `sms_received`, `form_submitted`, `followup_due`, `no_response_timeout`, `daily_review`.

**Available Actions:**
1. `send_sms` — Send SMS to lead (max 3/day from brain)
2. `schedule_followup` — Schedule delayed message
3. `cancel_pending_followups` — Stop messaging lead
4. `update_lead_stage` — Move lead through pipeline
5. `update_lead_score` — Adjust 0-10 score
6. `book_appointment` — Create booking via Cal.com
7. `notify_owner` — Alert via Telegram (urgency: low/medium/high/critical)
8. `log_insight` — Record business intelligence
9. `no_action` — Do nothing

**Guardrails:**
- Per-lead mutex lock (60s timeout, prevents concurrent decisions)
- Max 3 brain-initiated SMS per 24h per lead
- If lead transferred to owner → only notify_owner allowed
- If lead opted out → no SMS
- If AI paused (client.is_active=0) → only notify_owner
- Circuit breaker: 5 Claude API failures in 60s = 30s cooldown

---

## Lead Scoring (utils/leadScoring.js)

**Score = responsiveness(25%) + engagement(25%) + intent(20%) + recency(15%) + channel_diversity(15%)**

| Factor | Weight | Signal |
|--------|--------|--------|
| Responsiveness | 25% | How fast they responded (<5min=100, >1day=20) |
| Engagement | 25% | Total interactions (5+=100, 0=0) + inbound bonus |
| Intent | 20% | Source quality + call outcomes + sentiment |
| Recency | 15% | Hours since last contact (<1h=100, >1month=5) |
| Channel diversity | 15% | Multi-channel (phone+SMS=100, single=60) |

---

## Speed-to-Lead (utils/speed-to-lead.js)

5-touch automated sequence on new leads:

| Touch | Delay | Action |
|-------|-------|--------|
| 1 | Immediate | SMS with booking link |
| 2 | 60 seconds | AI callback via Retell |
| 3 | 5 minutes | Follow-up SMS if no booking |
| 4 | 24 hours | Reminder (deduped) |
| 5 | 72 hours | Final follow-up (deduped) |

All scheduling respects business hours. Telegram notification sent with cancel button.

---

## Billing (Stripe Integration)

| Plan | Price | Calls | Features |
|------|-------|-------|----------|
| Starter | $199/mo | 500 | AI Phone, SMS Auto-Reply, Missed Call Text-Back, Telegram |
| Pro | $399/mo | 1,500 | + Follow-Up Sequences, AI Brain, Lead Scoring, Weekly Reports |
| Premium | $799/mo | Unlimited | + New Customer Finder, Automated Outreach, Priority Support |

All plans include 7-day free trial. Stripe webhook at `/billing/webhook` handles: `checkout.session.completed`, `invoice.payment_succeeded`, `invoice.payment_failed`, `customer.subscription.deleted`.

---

## Environment Variables

**Required:**
- `ANTHROPIC_API_KEY` — Claude API (brain engine)

**Billing:**
- `STRIPE_SECRET_KEY` — Stripe API key
- `STRIPE_WEBHOOK_SECRET` — Webhook verification
- `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_SCALE` — Price IDs

**Voice:**
- `RETELL_API_KEY` — Voice AI provider

**SMS:**
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` — Primary SMS
- `TELNYX_API_KEY`, `TELNYX_PHONE_NUMBER`, `TELNYX_MESSAGING_PROFILE_ID` — Secondary SMS

**Telegram:**
- `TELEGRAM_BOT_TOKEN` — Bot token from @BotFather
- `TELEGRAM_WEBHOOK_SECRET` — Webhook verification secret
- `TELEGRAM_BOT_USERNAME` — Bot username (default: ElyvnBot)

**Auth:**
- `JWT_SECRET` — Dashboard authentication
- `ELYVN_API_KEY` — API key for internal/external API calls

**Optional:**
- `CALCOM_API_KEY`, `CALCOM_BOOKING_LINK`, `CALCOM_EVENT_TYPE_ID` — Cal.com booking
- `SMTP_*` — Cold email sending (Gmail or custom SMTP)
- `IMAP_*` — Reply checking
- `GOOGLE_MAPS_API_KEY` — Prospect scraping

---

## Database Schema (SQLite)

22 migrations, 70+ indexes. Key tables:

| Table | Purpose | Key Fields |
|-------|---------|------------|
| clients | Business accounts | id, telegram_chat_id, plan, is_active, avg_ticket, stripe_customer_id |
| leads | Prospect records | client_id, phone, score (0-10), stage, prospect_id |
| calls | Call records | client_id, call_id, outcome, transcript, score, duration |
| messages | SMS records | client_id, phone, direction, body, confidence |
| appointments | Bookings | client_id, lead_id, datetime, status |
| followups | Scheduled actions | lead_id, touch_number, type, scheduled_at, status |
| prospects | Scraped businesses | business_name, phone, email, rating, review_count |
| campaigns | Email campaigns | industry, city, total_sent/replied/booked |
| emails_sent | Individual emails | prospect_id, status, variant (A/B), open_count |
| job_queue | Background jobs | type, payload, status, retry_count, run_at |
| audit_log | Security + brain logs | action, details (JSON), client_id |
| weekly_reports | Aggregated stats | calls, appointments, revenue, missed_rate |

---

## Security Features

- Timing-safe API key comparison (crypto.timingSafeEqual)
- Timing-safe Telegram webhook verification
- Input validation and sanitization on all routes
- HTML escaping for Telegram output (`esc()` function)
- SSRF protection on scraping (blocks private IPs, localhost, metadata endpoints)
- Rate limiting (callbacks: 10/min/chat, forms: limited, API: per-key)
- Client isolation enforcement (multi-tenant)
- Helmet security headers
- CORS configured
- Audit logging for all sensitive actions
- Data retention policies (messages: 90d, calls: 365d, emails: 180d)
- Circuit breaker pattern for external API calls

---

## Deployment

| Service | Platform | URL |
|---------|----------|-----|
| Backend API | Railway | api.elyvn.net (DNS pending) / direct Railway URL |
| Landing Page | Vercel | elyvn-website.vercel.app |
| Dashboard | Same as backend | api.elyvn.net/dashboard |

**Railway project:** joyful-trust-production
**Vercel project:** elyvn-website (prj_Z49G8mvQzY69z9v21fUiyE8G1AbA)

---

## Urgent Items

1. **Railway trial expiring** — ~1 day / $3.45 left. Add payment method immediately.
2. **Custom domain DNS** — api.elyvn.net CNAME needs to point to Railway public domain.
3. **Twilio upgrade** — Trial account works for 5 customers, upgrade before scaling.
4. **Website push** — Run `git push` and `vercel --prod` from local Terminal to deploy latest changes.
