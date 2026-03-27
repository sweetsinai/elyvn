# ELYVN

> **AI-Powered Sales Automation Platform** — Voice calls, SMS, lead management, appointments, and real-time analytics in one unified system.

[![Node.js](https://img.shields.io/badge/node.js-18%2B-green?style=flat-square&logo=node.js)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Express](https://img.shields.io/badge/express-4.21-lightgrey?style=flat-square&logo=express)](https://expressjs.com)
[![React](https://img.shields.io/badge/react-19-61dafb?style=flat-square&logo=react)](https://react.dev)
[![SQLite](https://img.shields.io/badge/sqlite-3-003b57?style=flat-square&logo=sqlite)](https://sqlite.org)
[![Railway](https://img.shields.io/badge/railway-deployed-0b0d0e?style=flat-square&logo=railway)](https://railway.app)

---

## Overview

**ELYVN** is a multi-tenant AI-powered sales automation platform that transforms customer interactions into actionable insights. It seamlessly integrates voice calls, SMS, appointment booking, and email outreach into a single intelligent system powered by Anthropic's Claude AI.

### Core Features

- **Inbound Voice Calls** — AI agents handle calls via Retell AI with real-time transcription & sentiment analysis
- **SMS Conversations** — Claude-powered SMS replies with confidence scoring and escalation
- **Lead Management** — Automatic lead creation, scoring, and pipeline stage tracking
- **Speed-to-Lead** — Instant multi-touch sequences (SMS → callback → follow-ups)
- **Appointment Booking** — Integrated Cal.com bookings with cancellation support
- **Real-Time Notifications** — Telegram alerts for missed calls, transfers, complaints
- **Autonomous Brain** — AI makes post-interaction decisions and executes follow-up actions
- **Advanced Analytics** — Conversation intelligence, peak hours, response time impact, ROI metrics

---

## Architecture

```mermaid
graph TB
    subgraph Client["Client Layer"]
        Browser["Browser"]
        Dashboard["React Dashboard<br/>Vite + TailwindCSS"]
    end

    subgraph External["External Services"]
        Phone["Phone System"]
        RetellAI["Retell AI<br/>Voice Agent"]
        Telnyx["Telnyx<br/>SMS"]
        CalCom["Cal.com<br/>Bookings"]
        Claude["Anthropic Claude<br/>AI"]
        Telegram["Telegram Bot<br/>Notifications"]
    end

    subgraph Server["ELYVN Bridge<br/>Express.js Node.js"]
        Routes["Routes<br/>retell, telnyx, api"]
        Logic["Business Logic<br/>speed-to-lead, brain, scoring"]
        Agents["Agents<br/>Voice, SMS, Email"]
    end

    subgraph Data["Data Layer"]
        SQLite["SQLite Database<br/>multi-tenant"]
        Queue["Job Queue<br/>Async Processing"]
    end

    subgraph Hosting["Hosting"]
        Railway["Railway<br/>Production"]
    end

    Browser -->|Login, Data| Dashboard
    Dashboard -->|API Calls| Routes
    Phone -->|Inbound| RetellAI
    RetellAI -->|Webhook| Routes
    Telnyx -->|SMS Webhook| Routes
    CalCom -->|Booking Events| Routes
    Routes -->|AI Decisions| Logic
    Logic -->|Query/Update| SQLite
    Logic -->|Async Jobs| Queue
    Routes -->|API Call| Claude
    Logic -->|Messages| Telegram
    Routes -->|SMS Send| Telnyx
    Dashboard -.->|Real-time| Routes
    Routes -.->|WebSocket| Dashboard
    Railway -.->|Deploys| Server
```

---

## Call Flow Diagram

```mermaid
sequenceDiagram
    actor Caller
    participant RetellAI as Retell AI<br/>Voice Agent
    participant ELYVN as ELYVN<br/>Webhook Handler
    participant Claude as Anthropic<br/>Claude AI
    participant DB as SQLite<br/>Database
    participant Telegram as Telegram<br/>Notifications

    Caller->>RetellAI: Inbound Call
    activate RetellAI
    RetellAI->>ELYVN: call_started webhook
    activate ELYVN
    ELYVN->>DB: Insert call record
    ELYVN-->>RetellAI: 200 OK (async processing)
    deactivate ELYVN

    Note over RetellAI,Claude: AI Conversation
    RetellAI->>Claude: Send conversation context
    Claude->>RetellAI: AI Response
    RetellAI->>Caller: Speak to caller
    Caller->>RetellAI: Caller responds
    loop Until call ends
        RetellAI->>Claude: Analyze & respond
    end

    Caller->>RetellAI: Hangs up
    RetellAI->>ELYVN: call_ended webhook
    activate ELYVN
    ELYVN->>Claude: Summarize & score call
    Claude-->>ELYVN: Summary, score, outcome
    ELYVN->>DB: Update call with summary/score
    ELYVN->>DB: Upsert lead from caller phone
    ELYVN->>DB: Schedule speed-to-lead touches
    ELYVN->>Telegram: Notify owner
    activate Telegram
    Telegram-->>ELYVN: Message sent
    deactivate Telegram
    ELYVN->>Claude: Brain decision (post-call)
    Claude-->>ELYVN: Actions to execute
    ELYVN->>DB: Execute actions (follow-ups, SMS, etc)
    deactivate ELYVN
```

---

## SMS Flow Diagram

```mermaid
sequenceDiagram
    actor Customer as Customer
    participant Telnyx as Telnyx SMS<br/>Provider
    participant ELYVN as ELYVN<br/>Webhook Handler
    participant Claude as Claude AI<br/>SMS Reply
    participant DB as SQLite<br/>Database
    participant Telegram as Telegram<br/>Alerts

    Customer->>Telnyx: Send inbound SMS
    Telnyx->>ELYVN: message.received webhook
    activate ELYVN
    ELYVN->>DB: Check if already processed
    ELYVN->>DB: Load client by to_number
    ELYVN->>DB: Check AI enabled & rate limit

    alt AI Active
        ELYVN->>DB: Load knowledge base
        ELYVN->>Claude: Generate reply
        Claude-->>ELYVN: reply + confidence

        alt High Confidence
            ELYVN->>ELYVN: Reply confirmed
        else Low Confidence
            ELYVN->>ELYVN: Mark for escalation
            ELYVN->>Telegram: Send escalation alert
        end

        ELYVN->>Telnyx: Send SMS reply
        Telnyx-->>Customer: Reply received
    else AI Paused
        ELYVN->>Telegram: Log message only
    end

    ELYVN->>DB: Upsert lead
    ELYVN->>DB: Record inbound & outbound messages
    ELYVN->>Claude: Brain decision (post-SMS)
    Claude-->>ELYVN: Follow-up actions
    ELYVN->>DB: Execute actions
    ELYVN-->>Telnyx: 200 OK
    deactivate ELYVN
```

---

## Database Schema (ER Diagram)

```mermaid
erDiagram
    CLIENTS ||--o{ CALLS : initiates
    CLIENTS ||--o{ LEADS : contains
    CLIENTS ||--o{ MESSAGES : receives
    CLIENTS ||--o{ FOLLOWUPS : schedules
    CLIENTS ||--o{ BOOKINGS : manages
    CLIENTS ||--o{ CLIENT_API_KEYS : has
    CLIENTS ||--o{ JOB_QUEUE : queues

    LEADS ||--o{ CALLS : "has many"
    LEADS ||--o{ MESSAGES : "receives"
    LEADS ||--o{ FOLLOWUPS : "has"

    CALLS ||--o{ MESSAGES : "generates"

    CLIENTS {
        TEXT id PK "UUID"
        TEXT business_name
        TEXT owner_name
        TEXT owner_phone
        TEXT owner_email
        TEXT retell_agent_id "Retell AI agent ID"
        TEXT retell_phone "Inbound voice number"
        TEXT telnyx_phone "Inbound SMS number"
        TEXT twilio_phone "Fallback voice"
        TEXT transfer_phone "Manual transfer target"
        TEXT calcom_event_type_id
        TEXT calcom_booking_link
        TEXT telegram_chat_id "Owner notifications"
        TEXT timezone "UTC"
        DECIMAL avg_ticket "Average ticket value"
        BOOLEAN is_active "AI enabled"
        TEXT created_at
        TEXT updated_at
    }

    CALLS {
        TEXT id PK "UUID"
        TEXT call_id UK "Retell call ID"
        TEXT client_id FK
        TEXT caller_phone
        TEXT direction "inbound/outbound"
        INTEGER duration "seconds"
        TEXT outcome "info_provided, booked, transferred, missed, voicemail"
        DECIMAL score "1-10 lead quality"
        TEXT sentiment "positive, neutral, negative"
        TEXT transcript "Full call transcript"
        TEXT summary "2-line summary from Claude"
        TEXT analysis_data "JSON call analysis"
        TEXT created_at
        TEXT updated_at
    }

    LEADS {
        TEXT id PK "UUID"
        TEXT client_id FK
        TEXT phone "Unique per client"
        TEXT name
        TEXT email
        TEXT stage "new, contacted, qualified, booked, completed, lost"
        INTEGER score "1-10 prediction"
        TEXT source "call, sms, form, missed_call"
        TEXT calcom_booking_id "Booked appointment"
        TEXT last_contact
        TEXT created_at
        TEXT updated_at
    }

    MESSAGES {
        TEXT id PK "UUID"
        TEXT client_id FK
        TEXT lead_id FK
        TEXT phone
        TEXT channel "sms, email, telegram"
        TEXT direction "inbound, outbound"
        TEXT body
        TEXT confidence "high, medium, low"
        TEXT status "received, sent, auto_replied"
        TEXT message_sid "Telnyx message ID"
        TEXT created_at
    }

    FOLLOWUPS {
        TEXT id PK "UUID"
        TEXT lead_id FK
        TEXT client_id FK
        INTEGER touch_number "1-5+"
        TEXT type "sms, callback, email, nudge, reminder"
        TEXT content
        TEXT content_source "template, pending, custom"
        TEXT scheduled_at "ISO timestamp"
        TEXT completed_at
        TEXT status "scheduled, completed, skipped"
        TEXT created_at
    }

    BOOKINGS {
        TEXT id PK "UUID"
        TEXT client_id FK
        TEXT lead_id FK
        TEXT calcom_booking_id "Cal.com booking ID"
        TEXT attendee_name
        TEXT attendee_phone
        TEXT attendee_email
        TEXT start_time "ISO timestamp"
        TEXT status "confirmed, cancelled, completed"
        TEXT created_at
        TEXT updated_at
    }

    CLIENT_API_KEYS {
        TEXT id PK "UUID"
        TEXT client_id FK
        TEXT api_key_hash "SHA256 hash"
        TEXT permissions "JSON: read, write, admin"
        TEXT expires_at "ISO timestamp or null"
        BOOLEAN is_active
        TEXT last_used_at
        TEXT created_at
    }

    JOB_QUEUE {
        TEXT id PK "UUID"
        TEXT type "speed_to_lead_sms, callback, email_send, cleanup"
        TEXT payload "JSON job data"
        TEXT status "pending, processing, completed, failed"
        TEXT scheduled_at "ISO timestamp"
        INTEGER attempts "0-3"
        INTEGER max_attempts
        TEXT error "Failure reason"
        TEXT created_at
        TEXT updated_at
    }
```

---

## Lead Pipeline Diagram

```mermaid
stateDiagram-v2
    [*] --> new: New Lead Created

    new --> contacted: Call/SMS/Email
    new --> lost: No response

    contacted --> warm: Interest shown
    contacted --> lost: Disengaged

    warm --> hot: High engagement
    warm --> lost: Dropped off

    hot --> booked: Appointment confirmed
    hot --> qualified: Waiting to close
    hot --> lost: Changed mind

    qualified --> booked: Scheduled
    qualified --> lost: No show/Lost interest

    booked --> completed: Appointment attended
    booked --> lost: Cancelled

    completed --> [*]: Closed/Converted
    lost --> [*]: Archived

    note right of new
        Auto-created from:
        - Phone calls
        - SMS messages
        - Web forms
        - Missed calls
    end note

    note right of contacted
        Contact established
        Via any channel
    end note

    note right of warm
        Showing interest
        Engaging with content
    end note

    note right of hot
        High intent
        Close to decision
    end note

    note right of qualified
        Ready to close
        Decision pending
    end note

    note right of booked
        Appointment confirmed
        Via Cal.com
    end note
```

---

## Dashboard Pages

The dashboard provides 11 main pages for multi-tenant management:

| Page | Description |
|------|-------------|
| **Dashboard** | Real-time KPIs: calls this week, messages, bookings, revenue estimate, leads by stage |
| **Calls** | Searchable call log with transcripts, outcomes, scores, sentiment analysis, download capabilities |
| **Messages** | SMS conversation thread view with inbound/outbound history and AI confidence scores |
| **Pipeline** | Visual lead stage funnel, drag-to-update stages, predictive scoring, conversion analytics |
| **Intelligence** | Conversation intelligence: peak hours, average response time, sentiment trends, quality metrics |
| **Outreach** | Cold email campaigns via Engine 2: Google Maps scraping, SMTP sending, reply tracking via IMAP |
| **Bookings** | Cal.com integration: upcoming appointments, attendee details, cancellation handling |
| **Clients** | Multi-tenant client management: create, edit, configure integrations (Retell, Telnyx, Cal.com) |
| **ClientDetail** | Detailed client view: knowledge base management, business settings, phone number configuration |
| **Provision** | API key management: create per-client keys, set permissions, manage expiration |
| **Settings** | Global admin settings: business profile, notification preferences, integrations, logout |

---

## Tech Stack

### Backend
- **Runtime** — Node.js 18+
- **Framework** — Express.js 4.21
- **Database** — SQLite 3 (better-sqlite3) — embedded, fast, multi-tenant
- **AI** — Anthropic Claude API (claude-sonnet-4-20250514)
- **Voice** — Retell AI (inbound calls, transcription, sentiment)
- **SMS** — Telnyx (inbound/outbound SMS with Ed25519 signature verification)
- **Scheduling** — Cal.com (appointment booking, cancellations)
- **Notifications** — Telegram Bot API
- **Email** — Nodemailer + Node-IMAP (Engine 2 cold outreach)

### Frontend
- **Framework** — React 19 + JSX
- **Build Tool** — Vite 5 (ultra-fast development & production builds)
- **Styling** — TailwindCSS
- **Routing** — React Router v6
- **HTTP** — Native fetch API (no axios dependency)
- **Icons** — Lucide React

### Hosting & DevOps
- **Deployment** — Railway.app (push-to-deploy from Git)
- **Monitoring** — Sentry (optional error tracking)
- **Version Control** — Git

---

## Environment Variables

All environment variables are defined in `.env.example`. Here's a complete reference:

### Core Configuration
| Variable | Required | Description |
|----------|----------|-------------|
| `NODE_ENV` | No | `development` or `production` |
| `PORT` | No | Express server port (default: 3001) |
| `DATABASE_PATH` | No | SQLite database file path (default: ./elyvn.db) |

### Security
| Variable | Required | Description |
|----------|----------|-------------|
| `ELYVN_API_KEY` | Yes (prod) | Global API key protecting all endpoints & dashboard login |
| `CORS_ORIGINS` | No | Comma-separated allowed origins (e.g., `https://yourdomain.com`) |

### AI & Language Model
| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | **Yes** | Anthropic API key for Claude AI (voice summaries, SMS replies, brain decisions) |
| `CLAUDE_MODEL` | No | Claude model ID (default: `claude-sonnet-4-20250514`) |

### Voice Integration
| Variable | Required | Description |
|----------|----------|-------------|
| `RETELL_API_KEY` | No (optional) | Retell AI API key for voice agent features |
| `RETELL_WEBHOOK_SECRET` | No | Secret for HMAC-SHA256 webhook signature verification |

### SMS Integration
| Variable | Required | Description |
|----------|----------|-------------|
| `TELNYX_API_KEY` | No (optional) | Telnyx API key for SMS sending |
| `TELNYX_PHONE_NUMBER` | No | Inbound/outbound SMS phone number |
| `TELNYX_MESSAGING_PROFILE_ID` | No | Telnyx messaging profile ID |
| `TELNYX_PUBLIC_KEY` | No | Public key for Ed25519 webhook signature verification |

### Appointment Booking
| Variable | Required | Description |
|----------|----------|-------------|
| `CALCOM_API_KEY` | No (optional) | Cal.com API key for booking integration |
| `CALCOM_EVENT_TYPE_ID` | No | Cal.com event type ID for default scheduling |
| `CALCOM_BOOKING_LINK` | No | Cal.com public booking link for SMS/email |
| `MY_CALCOM_LINK` | No | Creator's personal Cal.com link (for Engine 2 prospects) |

### Notifications
| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | No (optional) | Telegram bot token for owner notifications |
| `TELEGRAM_WEBHOOK_SECRET` | No | Secret for Telegram webhook signature verification |

### Email Outreach (Engine 2)
| Variable | Required | Description |
|----------|----------|-------------|
| `SMTP_HOST` | No | SMTP server hostname (default: `smtp.gmail.com`) |
| `SMTP_PORT` | No | SMTP port (default: `587`) |
| `SMTP_USER` | No | SMTP username/email |
| `SMTP_PASS` | No | SMTP password or app-specific password |
| `SMTP_FROM_NAME` | No | Sender display name (default: `Sohan from ELYVN`) |

### Email Reply Tracking (Engine 2)
| Variable | Required | Description |
|----------|----------|-------------|
| `IMAP_HOST` | No | IMAP server hostname (default: `imap.gmail.com`) |
| `IMAP_PORT` | No | IMAP port (default: `993`) |
| `IMAP_USER` | No | IMAP username/email (same as SMTP_USER) |
| `IMAP_PASS` | No | IMAP password (same as SMTP_PASS) |

### Lead Generation (Engine 2)
| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_MAPS_API_KEY` | No | Google Maps API key for prospect scraping |

### Compliance
| Variable | Required | Description |
|----------|----------|-------------|
| `BUSINESS_ADDRESS` | No (optional) | Physical mailing address (required by CAN-SPAM for cold emails) |

### Monitoring & Error Tracking
| Variable | Required | Description |
|----------|----------|-------------|
| `SENTRY_DSN` | No | Sentry error tracking DSN (free tier available) |

---

## Quick Start

### Prerequisites
- Node.js 18+ (check: `node --version`)
- npm or yarn
- SQLite (included with better-sqlite3)

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/elyvn.git
cd elyvn

# Install dependencies
npm install

# Copy environment template and configure
cp .env.example .env

# Edit .env with your API keys
nano .env

# Start development server
cd server/bridge
npm run dev

# In another terminal, start the dashboard
cd dashboard
npm run dev

# Open http://localhost:5173 in your browser
```

### Production Deployment

```bash
# On Railway.app, set environment variables via dashboard
# Then deploy with a single git push

git push origin main

# Railway automatically builds and deploys:
# - Installs dependencies
# - Runs production build
# - Starts Express server on PORT=3001
# - Serves React dashboard from /public
```

---

## API Endpoints

### Webhooks (No Auth Required)
```
POST /webhooks/retell          - Retell AI call events
POST /webhooks/telnyx          - Telnyx SMS events
POST /webhooks/calcom          - Cal.com booking events
POST /webhooks/telegram        - Telegram message events
POST /webhooks/form            - Web form submissions
```

### Public APIs
```
GET  /health                   - Health check
POST /api/onboard/register     - Client registration
```

### Authenticated APIs (Require `x-api-key` header)
```
GET  /api/stats/:clientId      - Weekly KPIs
GET  /api/calls/:clientId      - Call history (paginated)
GET  /api/messages/:clientId   - SMS history (paginated)
GET  /api/leads/:clientId      - Lead pipeline (paginated)
PUT  /api/leads/:clientId/:leadId - Update lead stage
GET  /api/bookings/:clientId   - Upcoming appointments
POST /api/clients              - Create new client
PUT  /api/clients/:clientId    - Update client settings
POST /api/chat                 - Stream chat with Claude
GET  /api/intelligence/:clientId - Conversation intelligence report
GET  /api/revenue/:clientId    - ROI metrics
GET  /api/schedule/:clientId   - Daily contact schedule
```

---

## Deployment

### Railway.app (Recommended)

1. **Connect Repository**
   ```bash
   railway connect  # Link your GitHub repo
   ```

2. **Set Environment Variables**
   - Go to Railway dashboard → Settings → Environment
   - Add all required variables from `.env.example`
   - Important: Set `ELYVN_API_KEY` to a strong random string

3. **Deploy**
   ```bash
   git push origin main
   ```
   Railway automatically detects `package.json`, installs dependencies, and starts the server.

4. **Configure Domain**
   - Railway assigns a public URL (e.g., `https://elyvn-prod.up.railway.app`)
   - Go to Settings → Networking → Custom Domain to use your own domain
   - Update `CORS_ORIGINS` to match your domain

5. **Monitor Logs**
   ```bash
   railway logs
   ```

### Local Development with Docker (Optional)

```bash
docker build -t elyvn .
docker run -p 3001:3001 --env-file .env elyvn
```

---

## Features Deep Dive

### Voice Calls (Retell AI)
- **Inbound calls** to dedicated phone number ring Retell AI agent
- **Real-time transcription** and sentiment analysis
- **Claude summarizes** calls in 2 lines with 1-10 quality score
- **Automatic lead creation** from caller phone number
- **Speed-to-lead sequence**: SMS → callback → follow-up emails
- **Transfer to human** on demand (DTMF * or agent transfer)
- **Voicemail detection** with smart callback scheduling

### SMS Conversations (Telnyx)
- **Inbound SMS** automatically generate leads
- **Claude AI replies** using client knowledge base
- **Confidence scoring**: high/medium/low confidence responses
- **Low-confidence escalation** to owner via Telegram
- **TCPA compliance**: automatic STOP/UNSUBSCRIBE handling
- **5-minute rate limiting** per phone number
- **Opt-out tracking**: SMS_opt_outs table

### Lead Management
- **Auto-scoring**: 1-10 scale from call/SMS/booking interactions
- **Stage pipeline**: new → contacted → qualified → booked → completed
- **Recent interactions**: last 3 calls & messages per lead
- **Predictive scoring**: ML model predicts close probability
- **Batch operations**: Update multiple leads at once

### Speed-to-Lead Sequences
Triggered on any lead creation (call, SMS, form, missed call):
1. **Touch 1 (0s)**: SMS with booking link
2. **Touch 2 (60s)**: AI callback via Retell
3. **Touch 3 (5min)**: Follow-up SMS if no booking
4. **Touch 4 (24h)**: Reminder/nudge SMS
5. **Touch 5 (72h)**: Final follow-up SMS

### Autonomous Brain
Post-call and post-SMS, the system asks Claude:
- Should we send a follow-up? When?
- Should we update the lead stage?
- Should we schedule a callback?
- Should we escalate to the owner?

Claude makes decisions autonomously based on:
- Lead memory (previous interactions)
- Conversation sentiment
- Booking status
- Client business hours

### Real-Time Dashboard
- **WebSocket updates** for new calls, messages, bookings
- **Live call notifications** with transcript & score
- **SMS alerts** for escalations
- **Telegram integration** for offline notifications

---

## Architecture Highlights

### Multi-Tenant Isolation
- Each client is isolated by UUID
- API key permissions prevent cross-tenant access
- SQL queries always filter by `client_id`
- Webhook handlers validate client ownership

### Database Optimization
- **Indexes** on frequently queried columns: client_id, phone, created_at
- **Transactions** for atomic lead upserts
- **Prepared statements** prevent SQL injection
- **WAL mode** for concurrent read/write

### Error Handling & Resilience
- **Circuit breakers** for external API failures
- **Retry logic** with exponential backoff (3 attempts)
- **Graceful degradation**: SMS sends async via job queue
- **Unhandled rejection handlers** prevent silent crashes
- **Sentry integration** for production error tracking

### Security
- **Webhook signature verification**: HMAC-SHA256 (Retell), Ed25519 (Telnyx)
- **Timing-safe comparison** prevents timing attacks
- **Rate limiting**: 120 requests/minute per IP (LRU map)
- **Helmet.js** security headers
- **CORS validation**: whitelist allowed origins
- **API key hashing**: SHA256 stored in DB, compared timing-safe

---

## Monitoring & Debugging

### Health Check Endpoint
```bash
curl https://yourdomain/health
```

Returns: uptime, memory usage, database counts, configured services.

### View Logs
```bash
# Development
npm run dev  # Logs to console

# Production (Railway)
railway logs
```

### Database Inspection
```bash
# Open SQLite browser
sqlite3 ./elyvn.db

# Query examples
sqlite> SELECT COUNT(*) FROM calls;
sqlite> SELECT * FROM leads WHERE client_id = 'xxx' LIMIT 10;
sqlite> SELECT * FROM job_queue WHERE status = 'failed';
```

### Test API
```bash
# Health check
curl https://yourdomain/health

# Get calls (requires API key)
curl -H "x-api-key: YOUR_API_KEY" \
  https://yourdomain/api/calls/CLIENT_ID
```

---

## Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Commit changes (`git commit -am 'Add feature'`)
4. Push to branch (`git push origin feature/your-feature`)
5. Open a Pull Request

---

## License

MIT © 2024

---

## Support & Contact

For questions or support:
- GitHub Issues: [Report a bug](https://github.com/yourusername/elyvn/issues)
- Documentation: Check `/docs` folder
- Email: support@elyvn.net

---

## Roadmap

- [ ] WhatsApp integration
- [ ] Advanced lead scoring with ML
- [ ] Multi-language SMS support
- [ ] Custom AI agent personas
- [ ] Zapier/Make integration
- [ ] Advanced analytics dashboards
- [ ] Voice agent customization UI
- [ ] A/B testing for sequences

---

**Built with** ❤️ **by the ELYVN team**
