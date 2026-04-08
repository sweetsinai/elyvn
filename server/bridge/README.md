# ELYVN

### The AI employee that never sleeps, never forgets, and never misses a call.

ELYVN replaces the $42,000/year receptionist with an AI that answers every call, texts every lead within 2 minutes, scores them by likelihood to buy, books appointments automatically, requests Google reviews, and tells the business owner exactly who needs a callback — 24/7, for $299/month.

Built for home service businesses, dental offices, med spas, salons, auto shops, law firms, and anyone who loses money when the phone goes unanswered.

---

## What It Does

```
   Customer calls/texts/DMs              Owner gets Telegram alert
          |                                       ^
          v                                       |
   +------------------+                  +------------------+
   |   6 Inbound      |    Claude AI     |  5 Outbound      |
   |   Channels       | ----brain----->  |  Channels        |
   |                  |   8 actions      |                  |
   |  Phone (Retell)  |   0-100 score    |  SMS (Twilio)    |
   |  SMS (Twilio)    |   12 industries  |  Voice (Retell)  |
   |  WhatsApp        |   guardrails     |  Telegram        |
   |  FB Messenger    |                  |  Email (SMTP)    |
   |  Instagram DM    |                  |  Cal.com Book    |
   |  Web Forms       |                  |                  |
   +------------------+                  +------------------+
          |                                       |
          v                                       v
   +--------------------------------------------------+
   |              SQLite + Job Queue                    |
   |  Leads | Calls | Messages | Appointments | Events |
   +--------------------------------------------------+
```

---

## The 60-Second Pitch

A plumber misses 35% of incoming calls. Each missed call = $350+ in lost revenue. That's **$50,000/year walking out the door.**

ELYVN answers every one of those calls. The AI knows plumbing — it asks "Is there active flooding?" and triages emergencies. It texts the lead within 2 minutes, books the appointment, and sends a Google review request after the job. The plumber sees it all on Telegram.

**One recovered job per month pays for the entire service.**

---

## Quick Start

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
export JWT_SECRET=$(openssl rand -hex 32)
export ENCRYPTION_KEY=$(openssl rand -hex 32)
export ELYVN_API_KEY=$(openssl rand -hex 32)
node index.js
```

Server starts on port 3001. Migrations run automatically.

---

## 12 Industries, Zero Configuration

Drop ELYVN in and it already knows how to talk to your customers.

| Industry | What the AI knows | Emergency Detection |
|----------|-------------------|-------------------|
| **HVAC** | AC repair, heating, duct cleaning | Gas smell, CO alarm, no heat in winter |
| **Plumbing** | Leak repair, drain cleaning, water heater | Flooding, burst pipe, sewage backup |
| **Electrical** | Panel upgrades, outlets, EV chargers | Sparking, burning smell, exposed wires |
| **Dental** | Cleanings, fillings, root canals, Invisalign | Severe pain, swelling, bleeding |
| **Med Spa** | Botox, fillers, facials, laser, PRP | None (confidential tone, never promises results) |
| **Veterinary** | Wellness exams, vaccines, surgery, grooming | Not eating 24h+, seizures, poisoning |
| **Salon** | Cuts, color, highlights, extensions | None (fun/casual tone, walk-in check) |
| **Gym** | Tours, trial classes, personal training | None (motivating tone, free trial offers) |
| **Auto Repair** | Oil change, brakes, tires, diagnostics | None (collects year/make/model) |
| **Real Estate** | Viewings, listings, buyer consultations | None (routes buyer vs. seller) |
| **Legal** | Consultations, intake (NEVER gives advice) | DV resources, emergency contacts |
| **General** | Fallback for any business type | None |

40+ industry synonyms auto-map (e.g., "dental clinic" -> dental, "law firm" -> legal).

---

## The AI Brain

Claude analyzes every event and decides what to do. Autonomously.

### 8 Actions

| Action | Example |
|--------|---------|
| **Send SMS** | "Thanks for calling! Book online: cal.com/..." |
| **Schedule follow-up** | Queue a nudge for 48h later |
| **Cancel follow-ups** | Lead booked — stop selling |
| **Update stage** | new -> contacted -> warm -> hot -> booked |
| **Update score** | Score adjusted from 45 to 78 (high intent detected) |
| **Book appointment** | Creates Cal.com booking directly |
| **Notify owner** | "URGENT: This lead is ready to close" |
| **Log insight** | "Lead mentioned competitor pricing" |

### 5 Guardrails (so you don't get a $20 Twilio bill)

1. **Max 3 brain-initiated SMS per lead per 24h** — no spam
2. **5-minute rate limit** between SMS to the same number
3. **Opt-out detection** — "STOP" halts everything instantly
4. **Circuit breaker** — if Twilio fails 5x in 60s, all SMS stops for 30s
5. **Nonce dedup** — webhook retries can't trigger duplicate messages

---

## Lead Scoring (0-100)

Every lead gets a score. Updated daily at 6 AM.

| Factor | Weight | What it measures |
|--------|--------|-----------------|
| **Responsiveness** | 25% | How fast they replied |
| **Engagement** | 25% | Total calls + messages |
| **Intent** | 20% | Source quality + sentiment |
| **Recency** | 15% | Hours since last interaction |
| **Channel Diversity** | 15% | Both call AND SMS = higher |

**80+** = call immediately. **65-79** = follow up within 2h. **< 35** = nurture sequence.

---

## Speed-to-Lead

The first business to respond wins. ELYVN responds in under 2 minutes.

```
T+0        New lead detected (missed call / SMS / form / voicemail)
T+0-2min   Automatic SMS sent
T+5min     Outbound voice call via Retell (fallback: SMS if no answer)
T+2h       Follow-up SMS if no booking
T+48h      Second follow-up
```

After appointment:
```
T-24h      Reminder SMS
T-2h       Final reminder
T+2h       Google Review request (if review link configured)
```

---

## Telegram Bot (The Owner's Remote Control)

Business owners manage everything from their phone. No dashboard needed.

### Commands by Plan

| Command | Starter | Growth | Scale |
|---------|---------|--------|-------|
| `/status` | Dashboard overview | | |
| `/leads` | Lead list by stage | | |
| `/calls` | Recent calls + transcripts | | |
| `/today` | Today's appointments | | |
| `/stats` | 7-day performance | | |
| `/complete +phone` | Mark job done | | |
| `/pause` / `/resume` | Control AI | | |
| `/brain` | | AI activity feed | |
| `/outreach` | | | Campaign stats |
| `/scrape city industry` | | | Find prospects |

**Two-way reply:** Tap "Reply to lead" on any notification -> type your message -> ELYVN sends it as SMS. The lead's number is verified against your leads table (no spoofing).

**Menu is per-plan, per-client.** Set automatically when they connect via `/start`.

---

## Pricing

| Plan | Price | Calls | SMS | Best for |
|------|-------|-------|-----|----------|
| **Starter** | $299/mo | 500 | 1,000 | Solo operator, 1-2 locations |
| **Growth** | $499/mo | 1,500 | 3,000 | Growing SMB, multiple services |
| **Scale** | $799/mo | Unlimited | Unlimited | High-volume, multi-location |

7-day free trial on all plans. Usage tracked per-client per-month.

---

## White-Label for Agencies

Resell ELYVN under your brand.

```
POST /api/reseller/register    -> Create agency account
POST /api/reseller/login       -> Get JWT
POST /api/reseller/:id/create-client -> Spin up a sub-account
GET  /api/reseller/:id/stats   -> Your MRR dashboard
```

Each sub-account is a normal ELYVN client. Same features, same Telegram bot.

---

## Referral Program

Every account gets `ELYVN-XXXXXXXX` referral code at signup. Share via `?ref=CODE`. Referred user signs up -> referral tracked -> first payment triggers $50 credit to referrer.

---

## ROI Calculator (Public)

```
POST /api/calculator/roi
{
  "industry": "plumbing",
  "weekly_calls": 40,
  "avg_ticket": 450,
  "plan": "starter"
}

Response:
{
  "monthly_missed_calls": 61,
  "new_bookings_per_month": 9,
  "monthly_revenue_recovered": 4050,
  "elyvn_annual_cost": 3588,
  "roi_pct": 1254,
  "payback_days": 2
}
```

---

## API Surface

### Core
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/auth/signup` | Create account (accepts `referral_code`) |
| POST | `/auth/login` | Login -> JWT |
| GET | `/api/settings/:clientId` | All settings (9 categories) |
| PUT | `/api/settings/:clientId` | Update settings |
| GET | `/api/onboarding/:clientId` | 7-step wizard progress |
| GET | `/api/usage/:clientId` | Monthly usage vs. limits |
| POST | `/api/plan/:clientId/upgrade` | Self-serve Stripe upgrade |

### Leads & Analytics
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/leads/:clientId` | Lead list (filterable) |
| PUT | `/api/leads/:clientId/:leadId` | Update stage, revenue_closed |
| GET | `/api/stats/:clientId` | Weekly overview + trends |
| GET | `/api/stats/:clientId/roi` | ROI proof (what ELYVN caught) |
| GET | `/api/reports/:clientId/insights` | AI-generated business intelligence |
| GET | `/api/exports/:clientId/leads?format=csv` | CRM export |

### Webhooks (Inbound)
| Path | Source | Verification |
|------|--------|-------------|
| `/webhooks/retell` | Retell voice | HMAC-SHA256 + nonce |
| `/webhooks/twilio` | Twilio SMS | SHA1 HMAC |
| `/webhooks/whatsapp` | WhatsApp | SHA1 HMAC |
| `/webhooks/social` | FB + Instagram | SHA256 HMAC |
| `/webhooks/calcom` | Cal.com bookings | HMAC-SHA256 + timestamp |
| `/webhooks/form` | Web forms | Rate limited |
| `/webhooks/telegram` | Telegram bot | Secret token |
| `/billing/webhook` | Stripe | Stripe signature |

---

## Security

- All SQL parameterized (zero string interpolation)
- All webhooks HMAC-verified (timing-safe)
- All Telegram output HTML-escaped via `esc()`
- PII encrypted at rest (AES-256), masked in logs
- Per-client tenant isolation on every endpoint
- JWT with HMAC-SHA256, 24h expiry
- Rate limiting: 100/min general, 10/min auth, 300/min webhooks
- Circuit breakers on Claude, Twilio, Retell, Telegram, Cal.com
- 5-layer SMS loop prevention (nonce, dedup, rate limit, gap, guardrail)

---

## Scheduled Jobs

| Time | What happens |
|------|-------------|
| 3 AM | Data cleanup (old jobs, logs) |
| 6 AM | Batch lead scoring |
| 9 AM | AI lead review (brain decides per lead) |
| 10 AM | Cold email outreach |
| 7 PM | Daily summary to all clients (Telegram) |
| Mon 8 AM | AI weekly report with Claude insights |
| Every 2 min | Appointment reminders |
| Every 5 min | Follow-up processor |
| Every 30 min | Email reply checker |

---

## Onboarding (7 Steps)

1. Set business name + industry
2. Connect phone number (Twilio)
3. Configure voice AI (per-client voice selection)
4. Connect Telegram bot
5. Set Cal.com booking link
6. Add Google review link
7. Make a test call

Initialized to step 0 on signup. Progress auto-detected from configured fields.

---

## Environment Variables

### Required
```
ANTHROPIC_API_KEY    # Claude AI
JWT_SECRET           # JWT signing (32+ chars)
ENCRYPTION_KEY       # AES-256 for PII
ELYVN_API_KEY        # Master admin key
```

### Communication
```
TWILIO_ACCOUNT_SID   # SMS + WhatsApp
TWILIO_AUTH_TOKEN     # Signature verification
RETELL_API_KEY       # Voice calls
TELEGRAM_BOT_TOKEN   # Owner notifications
```

### Integrations
```
CALCOM_API_KEY       # Booking
STRIPE_SECRET_KEY    # Billing
META_VERIFY_TOKEN    # FB + Instagram
META_APP_SECRET      # Social webhook verification
```

### Optional
```
SENTRY_DSN                    # Error tracking
OTEL_EXPORTER_OTLP_ENDPOINT  # Distributed tracing
REDIS_URL                     # Nonce dedup (fallback: in-memory)
SMTP_HOST/USER/PASS           # Email outreach
```

---

## Tech Stack

- **Runtime:** Node.js 20
- **Database:** SQLite (better-sqlite3) with 39 auto-migrations
- **AI:** Anthropic Claude Sonnet 4 (configurable)
- **Voice:** Retell AI
- **SMS:** Twilio REST API (no SDK)
- **Frontend:** React 18 + Vite + React Router
- **Hosting:** Railway (auto-deploy from GitHub)
- **Monitoring:** Prometheus + Sentry + OpenTelemetry

---

*Built by Sohan Gowda. Every line of code audited to 10/10/10.*
