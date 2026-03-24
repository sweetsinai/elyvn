<div align="center">

<img src="https://readme-typing-svg.demolab.com?font=Fira+Code&weight=700&size=40&pause=1000&color=00E5CC&center=true&vCenter=true&random=false&width=500&height=70&lines=E+L+Y+V+N;AI+Operations+Platform;Never+Miss+A+Lead+Again" alt="ELYVN" />

<br/>

<img src="https://readme-typing-svg.demolab.com?font=Fira+Code&weight=400&size=16&pause=1000&color=8892B0&center=true&vCenter=true&random=false&width=600&height=30&lines=Answers+calls.+Replies+to+texts.+Books+appointments.+Markets+itself." alt="Tagline" />

<br/><br/>

[![Railway](https://img.shields.io/badge/Railway-Deployed-00E5CC?style=for-the-badge&logo=railway&logoColor=white)](https://joyful-trust-production.up.railway.app/health)
[![Node.js](https://img.shields.io/badge/Node.js-22-339933?style=for-the-badge&logo=node.js&logoColor=white)]()
[![Python](https://img.shields.io/badge/Python-3.12-3776AB?style=for-the-badge&logo=python&logoColor=white)]()
[![SQLite](https://img.shields.io/badge/SQLite-WAL-003B57?style=for-the-badge&logo=sqlite&logoColor=white)]()
[![Claude](https://img.shields.io/badge/Claude-Brain-D97706?style=for-the-badge&logo=anthropic&logoColor=white)]()
[![Tests](https://img.shields.io/badge/Hypergrade-71%2F71-00E5CC?style=for-the-badge)]()
[![Security](https://img.shields.io/badge/Code_Review-29%2F33_Fixed-059669?style=for-the-badge)]()

<br/>

```
 ██████╗ ██╗     ██╗   ██╗██╗   ██╗███╗   ██╗
██╔════╝ ██║     ╚██╗ ██╔╝██║   ██║████╗  ██║
█████╗   ██║      ╚████╔╝ ██║   ██║██╔██╗ ██║
██╔══╝   ██║       ╚██╔╝  ╚██╗ ██╔╝██║╚██╗██║
███████╗ ███████╗   ██║    ╚████╔╝ ██║ ╚████║
╚══════╝ ╚══════╝   ╚═╝    ╚═══╝  ╚═╝  ╚═══╝
```

**AI operations platform for service businesses.**<br/>
Answers every call. Replies to every text. Books every appointment. Markets itself while you sleep.

<br/>

[Live Server](https://joyful-trust-production.up.railway.app) · [Health Check](https://joyful-trust-production.up.railway.app/health) · [API Docs](#api-endpoints) · [Onboarding API](ONBOARDING_API.md) · [Quick Start](QUICK_START.md)

</div>

---

## How It Works

<div align="center">

```mermaid
graph TB
    subgraph INBOUND["INBOUND CHANNELS"]
        CALL["Phone Call"]
        SMS["SMS/Text"]
        FORM["Web Form"]
        CALWH["Cal.com Booking"]
        ONBOARD["Onboard API"]
    end

    subgraph ENGINE["ELYVN ENGINE (Railway)"]
        RETELL["Retell Webhook"]
        TWILIO["Twilio Webhook"]
        FORMWH["Form Webhook"]
        CALCOM["Cal.com Webhook"]
        BRAIN["BRAIN\n(Claude + Circuit Breaker\n+ Per-Lead Lock)"]
        STL["Speed-to-Lead\n(Persistent Job Queue)"]
        SCHED["Scheduler"]
        JOBQ["Job Queue\n(15s poll, 3 retries)"]
        DB[("SQLite\n(WAL + 12 tables\n+ migrations)")]
    end

    subgraph OUTBOUND["OUTBOUND"]
        SMSO["Auto-SMS Reply"]
        CALLBACK["AI Callback"]
        TGNOTIFY["Telegram Alert"]
        REVIEW["Review Request"]
        REMIND["Appt Reminder"]
    end

    subgraph MARKETING["ENGINE 2 (OpenClaw Agents)"]
        SCOUT["Scout\n(Google Maps)"]
        WRITER["Writer\n(Email Drafter)"]
        SENDER["Sender\n(HTML Templates)"]
        CLASSIFIER["Classifier\n(Auto-Respond)"]
    end

    subgraph SAFETY["SAFETY LAYER"]
        OPTOUT["Opt-Out Compliance"]
        BIZHRS["Business Hours"]
        CIRCUIT["Circuit Breakers"]
        BACKUP["Daily Backup"]
        LOG["Rotating Logs"]
    end

    CALL --> RETELL
    SMS --> TWILIO
    FORM --> FORMWH
    CALWH --> CALCOM
    ONBOARD --> DB

    RETELL --> BRAIN
    TWILIO --> BRAIN
    FORMWH --> STL
    CALCOM --> DB

    BRAIN --> JOBQ
    STL --> JOBQ
    SCHED --> JOBQ
    JOBQ --> DB

    JOBQ --> SMSO
    JOBQ --> CALLBACK
    BRAIN --> TGNOTIFY
    JOBQ --> REVIEW
    JOBQ --> REMIND

    OPTOUT -.-> SMSO
    BIZHRS -.-> JOBQ
    CIRCUIT -.-> BRAIN

    SCOUT --> WRITER
    WRITER --> SENDER
    SENDER --> CLASSIFIER
    CLASSIFIER --> TGNOTIFY

    style BRAIN fill:#D97706,stroke:#F59E0B,color:#fff
    style STL fill:#059669,stroke:#10B981,color:#fff
    style JOBQ fill:#0891B2,stroke:#06B6D4,color:#fff
    style DB fill:#1E40AF,stroke:#3B82F6,color:#fff
    style CIRCUIT fill:#DC2626,stroke:#EF4444,color:#fff
```

</div>

---

## Features

<table>
<tr>
<td width="50%">

### Engine 1 — AI Operations

<img src="https://readme-typing-svg.demolab.com?font=Fira+Code&size=14&pause=1000&color=00E5CC&vCenter=true&random=false&width=400&height=25&lines=Inbound+call+%E2%86%92+answered+in+600ms;SMS+received+%E2%86%92+replied+in+30s;Form+submitted+%E2%86%92+called+back+in+60s;Missed+call+%E2%86%92+text-back+in+5s" />

- **AI Call Answering** — Retell handles calls with custom KB, scores leads 1-10, summarizes every call
- **SMS Auto-Reply** — Claude generates contextual replies with confidence scoring + escalation
- **Speed-to-Lead** — Persistent job queue: SMS (0s) → AI callback (60s) → follow-up (5min) → nurture (24h/72h)
- **Missed Call Text-Back** — Instant SMS when missed or abandoned
- **Voicemail Handling** — Text-back + next-business-hour callback scheduling
- **Web Form Capture** — Universal webhook (WordPress, Typeform, Wix, Squarespace, custom)
- **Cal.com Webhooks** — Booking created/cancelled/rescheduled auto-updates leads + Telegram
- **Appointment Reminders** — Job queue integrated SMS reminders
- **Review Automation** — `/complete` → cancel reminders → review request in 2h
- **Cross-Channel Brain** — Per-lead mutex lock, circuit breaker, `book_appointment` action
- **Client Onboarding** — `POST /api/onboard` — atomic client creation + KB generation

</td>
<td width="50%">

### Engine 2 — Self-Marketing

<img src="https://readme-typing-svg.demolab.com?font=Fira+Code&size=14&pause=1000&color=8B5CF6&vCenter=true&random=false&width=400&height=25&lines=50+prospects+scraped+daily;30+cold+emails+sent+daily;Replies+auto-classified+%2B+responded;INTERESTED+%E2%86%92+email+%2B+SMS+%2B+Telegram" />

- **Scout Agent** — Google Maps scraper across 20 US cities, 5 industries
- **Writer Agent** — Claude-personalized cold emails using business data
- **Sender Agent** — HTML email templates, List-Unsubscribe headers, bounce detection
- **Classifier Agent** — Auto-classify replies + full INTERESTED conversion sequence
- **INTERESTED Flow** — Auto-reply with booking link + SMS + Telegram alert + 24h follow-up job
- **No-Reply Follow-up** — Day 3 follow-up via job queue for non-responders
- **Auto-Classify Endpoint** — `POST /auto-classify` for batch processing
- **CAN-SPAM Compliant** — Unsubscribe headers, bounced contacts blacklisted

### Production Safety

- **Circuit Breakers** — Claude API (5 fails → 30s cooldown), Retell API
- **SMS Opt-Out** — STOP/UNSUBSCRIBE/QUIT/END + re-opt-in (START)
- **Business Hours** — Delays sends until client's configured open hours
- **Persistent Job Queue** — Survives restarts, 3 retries, 15s polling
- **Daily Backups** — SQLite WAL checkpoint + file copy
- **Rotating Logs** — File-based, 7-day retention, structured prefixes
- **Metrics** — `recordMetric()` + `/metrics` endpoint
- **Migrations** — Versioned schema changes, `_migrations` tracking table
- **Dashboard Auth** — LoginGate + ErrorBoundary + API key enforcement

</td>
</tr>
</table>

---

## The Brain

<div align="center">

```mermaid
sequenceDiagram
    participant E as Event<br/>(Call/SMS/Form)
    participant I as Idempotency<br/>(Dedup Check)
    participant L as Lead Lock<br/>(60s timeout)
    participant M as Lead Memory
    participant CB as Circuit Breaker
    participant B as Brain (Claude)
    participant A as Action Executor
    participant O as Outputs

    E->>I: Webhook arrives
    I->>I: Check call_id/MessageSid
    I-->>E: Skip if duplicate
    I->>L: Acquire per-lead lock
    L->>M: getLeadMemory(phone)
    M-->>CB: Full timeline
    CB->>B: Call Claude (if circuit closed)
    CB-->>A: Fallback notify_owner (if open)
    B-->>A: Structured actions
    A->>A: Check opt-out status
    A->>O: send_sms (job queue)
    A->>O: book_appointment
    A->>O: schedule_followup
    A->>O: update_lead_stage
    A->>O: notify_owner
    L->>L: Release lock

    Note over CB: Opens after 5 failures<br/>in 60s window<br/>Cools down 30s
    Note over L: 60s timeout prevents<br/>deadlocks, force-releases
```

</div>

**Available Actions:**
| Action | What it does |
|--------|-------------|
| `send_sms` | SMS via Twilio (checks opt-out first, via job queue) |
| `book_appointment` | Create Cal.com booking (start_time, service, email, phone) |
| `schedule_followup` | Insert followup with timing + content |
| `cancel_pending_followups` | Cancel all pending followups for this lead |
| `update_lead_stage` | `new → contacted → warm → hot → booked → completed → lost → nurture` |
| `update_lead_score` | Score 1-10 with reason |
| `notify_owner` | Telegram alert with urgency level (low/medium/high/critical) |
| `log_insight` | Record brain reasoning for audit trail |
| `no_action` | Explicitly do nothing (logged) |

---

## Speed-to-Lead Engine

<div align="center">

```
Customer submits form / misses call / voicemail
         │
         ▼
    ┌─────────┐    ┌──────────────────────────────────┐
    │  0 sec   │──→ │ SMS with booking link              │──→ Job Queue
    └────┬────┘    │ (business hours aware)              │
         │         └──────────────────────────────────┘
         ▼
    ┌─────────┐    ┌──────────────────────────────────┐
    │  60 sec  │──→ │ AI callback via Retell             │──→ Job Queue
    └────┬────┘    │ (re-fetches client, checks stage)  │
         │         └──────────────────────────────────┘
         ▼
    ┌─────────┐    ┌──────────────────────────────────┐
    │  5 min   │──→ │ Follow-up SMS                      │──→ Job Queue
    └────┬────┘    │ (skips if booked/completed)         │
         │         └──────────────────────────────────┘
         ▼
    ┌─────────┐
    │  24 hr   │──→ Nurture SMS via brain (followups table)
    └────┬────┘
         ▼
    ┌─────────┐
    │  72 hr   │──→ Final nudge via brain
    └─────────┘
```

<img src="https://readme-typing-svg.demolab.com?font=Fira+Code&size=14&pause=2000&color=059669&center=true&vCenter=true&random=false&width=500&height=25&lines=All+jobs+persist+in+SQLite+job_queue+table;Survives+server+restarts+%E2%80%94+3+retries;Business+hours+aware+%E2%80%94+no+3+AM+texts" />

</div>

---

## Architecture

<div align="center">

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            RAILWAY (Production)                             │
│                                                                             │
│  ┌──────────────────────────────────┐  ┌──────────────────────────────┐    │
│  │    Bridge (Node.js 22)           │  │   MCP Server (Python 3.12)   │    │
│  │    Port 3001                     │  │   Port 8000                  │    │
│  │                                  │  │                              │    │
│  │  Webhooks:                       │  │   FastMCP 3.1.1              │    │
│  │  ├── /webhooks/retell            │  │   9 tool modules:            │    │
│  │  ├── /webhooks/twilio            │  │   ├── voice.py               │    │
│  │  ├── /webhooks/telegram          │  │   ├── messaging.py           │    │
│  │  ├── /webhooks/form/:clientId    │  │   ├── followup.py            │    │
│  │  ├── /webhooks/calcom            │  │   ├── booking.py             │    │
│  │  └── /api/*                      │  │   ├── intelligence.py        │    │
│  │                                  │  │   ├── reporting.py           │    │
│  │  Core:                           │  │   ├── scraper.py             │    │
│  │  ├── brain.js (circuit breaker)  │  │   ├── outreach.py            │    │
│  │  ├── leadMemory.js (ON CONFLICT) │  │   └── reply_handler.py       │    │
│  │  ├── actionExecutor.js           │  │   All wrapped in try/except  │    │
│  │  ├── speed-to-lead.js (job q)    │  └──────────────────────────────┘    │
│  │  ├── jobQueue.js                 │                                      │
│  │  ├── scheduler.js                │  ┌──────────────────────────────┐    │
│  │  ├── phone.js (centralized)      │  │   SQLite (/data/elyvn.db)    │    │
│  │  ├── sms.js (opt-out aware)      │  │   WAL mode | busy_timeout    │    │
│  │  └── telegram.js                 │  │   12 tables | migrations     │    │
│  │                                  │  │                              │    │
│  │  Safety:                         │  │   Tables:                    │    │
│  │  ├── optOut.js                   │  │   ├── clients, calls, leads  │    │
│  │  ├── businessHours.js            │  │   ├── messages, followups    │    │
│  │  ├── resilience.js (breakers)    │  │   ├── appointments           │    │
│  │  ├── metrics.js                  │  │   ├── job_queue              │    │
│  │  ├── backup.js                   │  │   ├── sms_opt_outs           │    │
│  │  ├── logger.js (rotating)        │  │   ├── prospects, campaigns   │    │
│  │  ├── migrations.js               │  │   ├── campaign_prospects     │    │
│  │  └── emailTemplates.js           │  │   ├── emails_sent            │    │
│  │                                  │  │   └── _migrations            │    │
│  │  Routes:                         │  └──────────────────────────────┘    │
│  │  ├── retell.js (idempotent)      │                                      │
│  │  ├── twilio.js (idempotent)      │  Volume: /data (persistent)          │
│  │  ├── telegram.js (15 commands)   │  Health: GET /health                  │
│  │  ├── forms.js                    │  Metrics: GET /metrics                │
│  │  ├── calcom-webhook.js           │  Rate limit: 120 req/min/IP          │
│  │  ├── onboard.js                  │  Backups: Daily WAL checkpoint        │
│  │  ├── api.js (UUID validated)     │  Logs: 7-day rotating files           │
│  │  └── outreach.js (+auto-classify)│                                      │
│  └──────────────────────────────────┘                                      │
│                                                                             │
│  ┌──────────────────────────────────┐                                      │
│  │  Dashboard (React/Vite)          │                                      │
│  │  LoginGate + ErrorBoundary       │                                      │
│  │  Authenticated API calls         │                                      │
│  └──────────────────────────────────┘                                      │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                        LOCAL MAC (OpenClaw Agents)                           │
│                                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐           │
│  │  Scout   │  │  Writer  │  │  Sender  │  │    Classifier    │           │
│  │  8 AM    │  │  8:30 AM │  │  10 AM   │  │    Every 30 min  │           │
│  │  Scrape  │→ │  Draft   │→ │  Send    │→ │  Classify+Reply  │           │
│  │  50/day  │  │  emails  │  │  30/day  │  │  + INTERESTED    │           │
│  │          │  │          │  │  HTML     │  │    conversion    │           │
│  └──────────┘  └──────────┘  └──────────┘  └──────────────────┘           │
└─────────────────────────────────────────────────────────────────────────────┘
```

</div>

---

## Project Structure

```
elyvn/
├── server/
│   ├── bridge/                            # Node.js Express server
│   │   ├── index.js                       # Entry, middleware, routes, env validation
│   │   ├── routes/
│   │   │   ├── retell.js                  # call_started/ended/analyzed, voicemail, idempotent
│   │   │   ├── twilio.js                  # SMS reply, opt-out/opt-in, idempotent
│   │   │   ├── telegram.js                # 15 bot commands + callback buttons
│   │   │   ├── forms.js                   # Universal form webhook
│   │   │   ├── calcom-webhook.js          # Booking created/cancelled/rescheduled
│   │   │   ├── onboard.js                 # POST /api/onboard (atomic)
│   │   │   ├── api.js                     # REST API (UUID validated, async file I/O)
│   │   │   └── outreach.js               # Campaigns, email scraping, auto-classify
│   │   ├── utils/
│   │   │   ├── brain.js                   # Claude orchestrator + circuit breaker + lead lock
│   │   │   ├── leadMemory.js              # Timeline builder (INSERT ON CONFLICT)
│   │   │   ├── actionExecutor.js          # Execute brain decisions (opt-out aware, book_appointment)
│   │   │   ├── speed-to-lead.js           # Job queue powered, business hours aware
│   │   │   ├── jobQueue.js                # Persistent queue (job_queue table, 3 retries)
│   │   │   ├── phone.js                   # Centralized E.164 normalization
│   │   │   ├── sms.js                     # Twilio SMS (opt-out check, retry backoff)
│   │   │   ├── telegram.js                # Bot API + formatters
│   │   │   ├── scheduler.js               # Cron: summary, report, followups, outreach, reminders
│   │   │   ├── calcom.js                  # createBooking, cancelBooking, getAvailability
│   │   │   ├── optOut.js                  # STOP/UNSUBSCRIBE/QUIT/END compliance
│   │   │   ├── businessHours.js           # Per-client delay engine
│   │   │   ├── appointmentReminders.js    # Job queue integrated
│   │   │   ├── resilience.js              # CircuitBreaker + retryWithBackoff
│   │   │   ├── metrics.js                 # recordMetric + /metrics
│   │   │   ├── backup.js                  # Daily WAL checkpoint + copy
│   │   │   ├── logger.js                  # Rotating file logs (7-day)
│   │   │   ├── migrations.js              # Versioned schema (_migrations table)
│   │   │   ├── emailTemplates.js          # Responsive HTML + CTA wrappers
│   │   │   ├── emailGenerator.js          # Claude cold email generator
│   │   │   ├── emailSender.js             # Nodemailer + bounce detection
│   │   │   └── replyClassifier.js         # Claude reply classifier
│   │   └── public/                        # Dashboard build + embed.js
│   ├── mcp/                               # Python FastMCP server
│   │   ├── main.py                        # MCP entry
│   │   ├── db.py                          # SQLite schema
│   │   ├── knowledge_bases/               # Per-client KB (JSON)
│   │   └── tools/                         # 9 modules (all try/except wrapped)
│   └── requirements.txt
├── dashboard/                             # React + Vite
│   └── src/
│       ├── App.jsx                        # Main app
│       ├── lib/api.js                     # Authenticated API client
│       └── components/
│           ├── LoginGate.jsx              # API key auth gate
│           └── ErrorBoundary.jsx          # Crash recovery
├── landing/index.html                     # Landing page
├── tests/hypergrade.js                    # 71-test production suite
├── ONBOARDING_API.md                      # Client onboarding docs
├── QUICK_START.md                         # Quick start guide
├── Dockerfile                             # Python 3.12 + Node 22
└── package.json
```

---

## Database Schema

SQLite with WAL mode, `busy_timeout = 5000`, `foreign_keys = ON`. 12 tables, versioned migrations.

```mermaid
erDiagram
    clients ||--o{ calls : "has"
    clients ||--o{ leads : "has"
    clients ||--o{ messages : "has"
    clients ||--o{ sms_opt_outs : "tracks"
    clients ||--o{ appointments : "has"
    leads ||--o{ followups : "has"
    leads ||--o{ messages : "has"
    prospects ||--o{ emails_sent : "receives"
    campaigns ||--o{ emails_sent : "contains"

    clients {
        text id PK
        text business_name
        text retell_phone
        text twilio_phone
        text retell_agent_id
        text telegram_chat_id
        text google_review_link
        text business_hours JSON
        int is_active
        real avg_ticket
    }
    calls {
        text id PK
        text call_id UK
        text client_id FK
        text caller_phone
        int duration
        text outcome
        int score
        text summary
    }
    leads {
        text id PK
        text client_id FK
        text phone UK_with_client
        text name
        int score
        text stage
        text email
        text calcom_booking_id
    }
    messages {
        text id PK
        text client_id FK
        text phone
        text direction
        text body
        text confidence
        text reply_source
        text message_sid UK
    }
    followups {
        text id PK
        text lead_id FK
        int touch_number
        text type
        text scheduled_at
        text status
    }
    job_queue {
        text id PK
        text type
        text payload JSON
        text scheduled_at
        text status
        int attempts
        int max_attempts
    }
    sms_opt_outs {
        text id PK
        text phone
        text client_id
        text reason
    }
    appointments {
        text id PK
        text client_id FK
        text phone
        text datetime
        text status
        text calcom_booking_id
    }
    prospects {
        text id PK
        text business_name
        text email
        text industry
        text city
        real rating
        int review_count
        text status
    }
    emails_sent {
        text id PK
        text prospect_id FK
        text campaign_id FK
        text to_email
        text subject
        text body
        text status
        text reply_text
        text reply_classification
        int auto_response_sent
    }
```

---

## Webhook Event Ordering (Critical)

```
Retell sends events in this order (not guaranteed):
  1. call_started    → insert call record
  2. call_analyzed   → backfill transcript + summary (can arrive BEFORE call_ended)
  3. call_ended      → score, outcome, brain, Telegram, speed-to-lead

IMPORTANT: Idempotency checks on call_ended use `outcome IS NOT NULL`
(not summary) because call_analyzed sets summary first.
```

---

## Event Flows

### Inbound Call

```
Retell webhook → POST /webhooks/retell
│
├─ Idempotency: skip if outcome already set (not summary — call_analyzed sets that first)
│
├─ call_started → Insert call record, match client by phone or agent_id
│
├─ call_ended
│  ├─ 1. Fetch transcript (10s timeout, fallback to payload)
│  ├─ 2. Generate summary (Claude, circuit breaker protected)
│  ├─ 3. Score lead 1-10
│  ├─ 4. Determine outcome (booked/transferred/missed/voicemail/info)
│  ├─ 5. Upsert lead (INSERT ON CONFLICT)
│  ├─ 6. Schedule follow-ups
│  ├─ 7. Missed → speed-to-lead (job queue)
│  ├─ 8. Voicemail → text-back + next-business-hour callback
│  ├─ 9. Telegram notification
│  └─ 10. BRAIN (per-lead lock → circuit breaker → execute)
│
├─ call_analyzed → Backfill transcript + summary if missing
│
└─ agent_transfer / dtmf(*) → Live transfer
```

### Inbound SMS

```
Twilio webhook → POST /webhooks/twilio
│
├─ Idempotency: skip duplicate MessageSid
│
├─ STOP/UNSUBSCRIBE/QUIT/END → Record opt-out + confirmation SMS
├─ START/SUBSCRIBE → Re-opt-in + welcome SMS
├─ CANCEL → Cancel Cal.com booking
├─ YES → Send booking link
│
└─ Normal message:
   ├─ 1. Check opt-out status
   ├─ 2. Check is_active (paused → log only)
   ├─ 3. Rate limit (5-min cooldown)
   ├─ 4. Load KB (capped at 5000 chars)
   ├─ 5. Claude reply (circuit breaker)
   ├─ 6. Low confidence → escalate
   ├─ 7. Log inbound + outbound
   ├─ 8. Telegram notification
   └─ 9. BRAIN (per-lead lock → actions)
```

### Cal.com Booking

```
Cal.com webhook → POST /webhooks/calcom
│
├─ BOOKING_CREATED → Upsert lead (stage=booked) + cancel pending followups + Telegram
├─ BOOKING_CANCELLED → Revert lead stage + Telegram
└─ BOOKING_RESCHEDULED → Update appointment + Telegram
```

### Cold Email Reply (INTERESTED)

```
Reply classified as INTERESTED →
│
├─ 1. Auto-reply email with Cal.com booking link
├─ 2. SMS with booking link (if prospect has phone)
├─ 3. Telegram alert (priority notification)
└─ 4. Schedule 24h follow-up job (if no booking)
```

---

## Scheduled Tasks

| Task | Interval | Description |
|------|----------|-------------|
| **Job Queue Processor** | Every 15s | Process pending jobs (SMS, callbacks, reminders, follow-ups) |
| **Appointment Reminders** | Every 2 min | Check for upcoming appointments, send reminders |
| Follow-up Processor | Every 5 min | Process due followups through brain |
| Daily Summary | 7 PM IST | Telegram: calls, bookings, messages, revenue |
| Weekly Report | Monday 8 AM | Telegram: weekly performance |
| Daily Lead Review | 9 AM | Brain reviews stale leads |
| Daily Outreach | 10 AM | Engine 2: send campaign emails |
| Reply Checker | Every 30 min | IMAP inbox scan for replies |
| **Daily Backup** | Every 24h | SQLite WAL checkpoint + file copy |

---

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Connect account |
| `/today` | Today's booked appointments |
| `/stats` | 7-day stats: calls, bookings, missed, revenue |
| `/calls` | Last 5 calls with outcome + score |
| `/leads` | Hot leads (score >= 7) |
| `/brain` | Last 10 brain decisions |
| `/pause` | Pause AI |
| `/resume` | Resume AI |
| `/complete +phone` | Mark done → cancel reminders → review request 2h |
| `/setreview URL` | Set Google review link |
| `/outreach` | Campaign stats |
| `/scrape industry city` | Trigger scrape |
| `/prospects` | Latest prospects |
| `/help` | All commands |

---

## API Endpoints

All `/api` routes require `x-api-key` header when `ELYVN_API_KEY` is set.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | DB counts, env vars, memory, uptime, pending jobs |
| `GET` | `/metrics` | Internal metrics |
| `POST` | `/api/onboard` | Atomic client onboarding ([docs](ONBOARDING_API.md)) |
| `GET` | `/api/clients` | List clients (max 100) |
| `POST` | `/api/clients` | Create client |
| `PUT` | `/api/clients/:id` | Update (UUID validated, async file I/O) |
| `GET` | `/api/calls/:clientId` | List calls (filter: outcome, dates, score) |
| `GET` | `/api/leads/:clientId` | List leads |
| `GET` | `/api/messages/:clientId` | List messages |
| `GET` | `/api/followups/:clientId` | List followups |
| `POST` | `/api/outreach/scrape` | Scrape Google Maps (email extraction from websites) |
| `POST` | `/api/outreach/campaigns` | Create campaign |
| `POST` | `/api/outreach/campaign/:id/generate` | Generate emails for campaign |
| `POST` | `/api/outreach/campaign/:id/send` | Send campaign (daily limit enforced) |
| `POST` | `/api/outreach/replies/:id/classify` | Classify reply |
| `POST` | `/api/outreach/auto-classify` | Batch classify all unclassified replies |

---

## Webhook URLs

| Service | URL |
|---------|-----|
| Retell | `https://joyful-trust-production.up.railway.app/webhooks/retell` |
| Twilio SMS | `https://joyful-trust-production.up.railway.app/webhooks/twilio` |
| Telegram | `https://joyful-trust-production.up.railway.app/webhooks/telegram` |
| Cal.com | `https://joyful-trust-production.up.railway.app/webhooks/calcom` |
| Web Forms | `https://joyful-trust-production.up.railway.app/webhooks/form/:clientId` |

---

## Embed Widget

```html
<form id="elyvn-form">
  <input name="name" placeholder="Name" required>
  <input name="phone" placeholder="Phone" required>
  <textarea name="message" placeholder="How can we help?"></textarea>
  <button type="submit">Send</button>
</form>
<script src="https://joyful-trust-production.up.railway.app/embed.js"
        data-client-id="YOUR_CLIENT_ID"></script>
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Claude API |
| `RETELL_API_KEY` | Yes | Retell API |
| `TWILIO_ACCOUNT_SID` | Yes | Twilio SID |
| `TWILIO_AUTH_TOKEN` | Yes | Twilio auth |
| `TWILIO_PHONE_NUMBER` | Yes | Twilio number |
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot |
| `TELEGRAM_WEBHOOK_SECRET` | Yes | Webhook secret |
| `DATABASE_PATH` | No | SQLite path (default: `/data/elyvn.db`) |
| `CLAUDE_MODEL` | No | Model (default: `claude-sonnet-4-20250514`) |
| `ELYVN_API_KEY` | No | API auth (REQUIRED for production) |
| `CORS_ORIGINS` | No | Allowed origins (default: all) |
| `CALCOM_API_KEY` | No | Cal.com API |
| `CALCOM_BOOKING_LINK` | No | Cal.com booking URL |
| `GOOGLE_MAPS_API_KEY` | No | Google Maps |
| `SMTP_HOST` | No | SMTP server |
| `SMTP_PORT` | No | SMTP port |
| `SMTP_USER` | No | SMTP username |
| `SMTP_PASS` | No | SMTP password |
| `EMAIL_DAILY_LIMIT` | No | Max emails/day (default: 300) |
| `OUTREACH_SENDER_NAME` | No | Sender name (default: Sohan) |
| `BUSINESS_ADDRESS` | No | CAN-SPAM address |
| `LOG_DIR` | No | Log directory |
| `LOG_RETENTION_DAYS` | No | Log retention (default: 7) |

---

## Security & Hardening

| Category | Protection |
|----------|-----------|
| Process | `unhandledRejection` + `uncaughtException` handlers |
| Startup | Env var validation, warns on missing keys |
| Routes | Every handler in try-catch |
| JSON | 400 for parse errors (not 500) |
| Database | WAL, busy_timeout, UNIQUE indexes, transactions, migrations |
| Rate limiting | 120 req/min/IP, 5-min SMS cooldown, 3 brain SMS/24h |
| Auth | API key on `/api`, Telegram webhook secret, dashboard LoginGate |
| Idempotency | Retell: outcome-based dedup, Twilio: MessageSid dedup |
| Brain | Per-lead lock (60s timeout), circuit breaker (5 fails → 30s cooldown) |
| SMS | Opt-out compliance, checked before every send |
| Data | PII stripped from logs, KB capped at 5000 chars |
| Files | UUID validation on paths, async I/O |
| Network | 10s fetch timeout, AbortSignal on external APIs |
| Email | CRLF header sanitization, List-Unsubscribe, bounce blacklist |
| Backups | Daily WAL checkpoint + file copy |
| Logs | Rotating file logger, 7-day retention |
| Python | All 9 MCP tools wrapped in try/except |

---

## Deployment

```bash
npm run dev          # MCP + Bridge + Dashboard (local)
npm run build        # Dashboard → server/bridge/public/
railway up --detach  # Deploy to Railway
```

---

## Testing

```bash
BASE_URL=https://joyful-trust-production.up.railway.app node tests/hypergrade.js
```

71 tests across 13 sections: infrastructure, Retell pipeline, missed call, SMS + brain, speed-to-lead, forms (7 variants), Telegram (15 commands), concurrency stress, malformed attacks, full E2E flow, agent files, embed, auth.

---

## Post-Max Survival

```bash
CLAUDE_MODEL=claude-haiku-4-5-20251001   # 12x cheaper, one env var change
```

| Item | Cost |
|------|------|
| Railway | $5/mo |
| Claude Haiku API | $5-15/mo |
| OpenClaw agents (NVIDIA free tier) | $0/mo |
| **Total** | **$10-20/mo** |

---

<div align="center">

<img src="https://readme-typing-svg.demolab.com?font=Fira+Code&weight=600&size=18&pause=1000&color=00E5CC&center=true&vCenter=true&random=false&width=600&height=30&lines=Built+by+Sohan+Gowda+%7C+Age+20+%7C+Bangalore;One+engineer.+Five+AI+agents.+Zero+missed+leads." />

<br/><br/>

[![GitHub](https://img.shields.io/badge/GitHub-sweetsinai%2Felyvn-181717?style=for-the-badge&logo=github)](https://github.com/sweetsinai/elyvn)

</div>
