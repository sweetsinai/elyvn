# ELYVN — AI Receptionist for Local Service Businesses

ELYVN is an autonomous AI receptionist that answers every phone call, qualifies leads, books appointments, and follows up via SMS — so local businesses never miss another customer.

**Live at [elyvn.net](https://elyvn.net)** | Backend at [api.elyvn.net](https://api.elyvn.net)

---

## What ELYVN Does

Local service businesses (dental offices, med spas, salons, HVAC, plumbing) lose $2,800–$8,400/month to missed calls. ELYVN replaces the need for a full-time receptionist at a fraction of the cost.

### The Complete Call Flow

```
Customer Calls
      │
      ▼
┌─────────────────────┐
│  Retell Voice AI     │  AI picks up instantly — 24/7, weekends, holidays.
│  answers the call    │  Uses a niche-specific knowledge base (dental, medspa,
│                      │  salon, HVAC, etc.) to handle the conversation naturally.
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  Post-Call Webhook   │  Call ends. Webhook fires to ELYVN backend.
│  triggers the Brain  │  Transcript + caller info sent to the AI Brain.
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  AI Brain            │  Autonomous decision engine (utils/brain.js):
│  (Claude API)        │  • Analyzes transcript + lead history
│                      │  • Assigns lead score (0–10)
│                      │  • Decides next actions automatically:
│                      │    → Send SMS follow-up
│                      │    → Book appointment on Cal.com
│                      │    → Trigger follow-up sequence
│                      │    → Update pipeline stage
│                      │    → Alert owner via Telegram
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  Actions Execute     │  SMS sent via Twilio/Telnyx.
│  Automatically       │  Appointment booked on Cal.com.
│                      │  Telegram notification with full summary.
│                      │  Dashboard updated in real-time via WebSocket.
└─────────────────────┘
```

### What Makes It Different

**The Brain is autonomous.** Most AI receptionists just answer calls. ELYVN's Brain analyzes every interaction and decides what to do next — no human in the loop. It scores leads, routes high-value prospects to priority follow-up, and triggers multi-touch SMS sequences automatically.

**Niche-specific from day one.** 11 industry templates (dental, medspa, salon, HVAC, plumbing, roofing, auto repair, chiropractic, veterinary, fitness, real estate) each with custom knowledge bases, call scripts, and follow-up logic tailored to that vertical. A dental AI talks about cleanings and crowns, not generic appointment booking.

**Speed-to-lead automation.** The moment a call ends, follow-up fires. Industry data shows responding within 5 minutes increases conversion 21x. ELYVN responds in under 30 seconds.

---

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Voice AI** | Retell AI | Natural voice conversations, call handling, transcription |
| **Backend** | Node.js + Express | API server, webhook processing, business logic |
| **Database** | better-sqlite3 | Client data, leads, calls, messages, pipeline (21 migrations) |
| **AI Brain** | Anthropic Claude API | Autonomous decision engine — lead scoring, action planning |
| **SMS** | Twilio (primary) + Telnyx (secondary) | Outbound/inbound SMS, missed call text-back |
| **Booking** | Cal.com | Appointment scheduling, calendar integration |
| **Billing** | Stripe | Subscription management (Starter/Growth/Scale) |
| **Notifications** | Telegram Bot API | Real-time alerts, command center (/stats, /leads, /pause) |
| **Auth** | Custom JWT | HS256 tokens, crypto.scrypt passwords, API key hashing |
| **Dashboard** | React 18 + Vite + Tailwind | 12-page SPA with WebSocket real-time updates |
| **Website** | Static HTML + Three.js + GSAP | Landing page with 3D hero, scroll animations, ROI calculator |
| **Hosting** | Railway (backend) + Vercel (website) | Production deployment |

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                      ELYVN Platform                       │
├────────────────────┬─────────────────────────────────────┤
│                    │                                      │
│   ELYVN-Website    │          ELYVN Backend               │
│   (This Repo)      │     (api.elyvn.net — Railway)        │
│                    │                                      │
│   Static HTML      │   server/                            │
│   Three.js hero    │   ├── routes/                        │
│   GSAP animations  │   │   ├── auth.js (JWT login/signup) │
│   ROI calculator   │   │   ├── retell.js (voice webhooks) │
│   Pricing page     │   │   ├── twilio.js (SMS webhooks)   │
│   → Vercel         │   │   ├── telnyx.js (SMS fallback)   │
│                    │   │   ├── stripe.js (billing)         │
│                    │   │   ├── calcom.js (bookings)        │
│                    │   │   ├── telegram.js (bot commands)  │
│                    │   │   ├── leads.js (pipeline CRUD)    │
│                    │   │   ├── calls.js (call history)     │
│                    │   │   ├── messages.js (SMS history)   │
│                    │   │   ├── clients.js (multi-tenant)   │
│                    │   │   ├── onboard.js (setup wizard)   │
│                    │   │   └── ... (17 route files total)  │
│                    │   ├── utils/                          │
│                    │   │   ├── brain.js (AI decision engine)│
│                    │   │   ├── db.js (SQLite + migrations) │
│                    │   │   └── knowledge.js (KB generator) │
│                    │   └── server.js (Express entry point) │
│                    │                                      │
│   dashboard/       │   Integrations:                      │
│   ├── LoginGate    │   ├── Retell AI (voice)              │
│   ├── Dashboard    │   ├── Twilio + Telnyx (SMS)          │
│   ├── Calls        │   ├── Stripe (billing)               │
│   ├── Messages     │   ├── Cal.com (booking)              │
│   ├── Pipeline     │   ├── Telegram (notifications)       │
│   ├── Intelligence │   ├── Claude API (brain)             │
│   ├── Outreach     │   ├── Google Places (enrichment)     │
│   ├── Bookings     │   └── SMTP (email)                   │
│   ├── Settings     │                                      │
│   └── Onboard      │   Security:                          │
│       (4-step      │   ├── Helmet + CORS                  │
│        wizard)     │   ├── Rate limiting (100/min)        │
│                    │   ├── Auth rate limit (10/min)        │
│                    │   ├── Audit logging                   │
│                    │   └── API key hashing (SHA-256)       │
└────────────────────┴─────────────────────────────────────┘
```

---

## The AI Brain (utils/brain.js)

The Brain is the core differentiator. It's an autonomous post-call decision engine powered by Claude:

```
Input:  call transcript + lead history + client knowledge base
  │
  ▼
┌─────────────────────────────────┐
│  Claude API Analysis            │
│                                 │
│  1. Understand call context     │
│  2. Score lead quality (0-10)   │
│  3. Determine pipeline stage    │
│  4. Decide optimal next actions │
└──────────┬──────────────────────┘
           │
           ▼
Output: Array of autonomous actions
  ├── send_sms("Thanks for calling! Here's your booking link...")
  ├── book_appointment(date, time, service)
  ├── update_stage("qualified")
  ├── trigger_sequence("follow_up_3day")
  └── notify_owner("High-value lead: Dr. Smith, score 9/10")
```

**Safety features:**
- Per-lead locking (prevents duplicate actions on concurrent calls)
- Circuit breaker pattern (stops if error rate exceeds threshold)
- Guardrails (max SMS per lead per day, required cooling periods)
- Full audit trail of every decision

---

## Website (This Repo)

### Sections

| Section | Description |
|---------|-------------|
| **Hero** | Three.js 3D scene — wireframe torus rings + icosahedron sphere + dot grid. Mouse parallax. |
| **Social Proof Bar** | Key stats: 22 missed calls recovered/month, <30s response time, 3-5x ROI |
| **How It Works** | 3-step flow: Connect Phone → AI Answers → Get Results |
| **Features Grid** | 8 live features with LIVE badges |
| **The AI Brain** | 4-step visual flow explaining the autonomous decision engine |
| **ROI Calculator** | Interactive calculator: enter job value + missed calls → see monthly revenue lost |
| **Pricing** | 3 tiers: Starter $299/mo, Growth $499/mo, Scale $799/mo |
| **Results Timeline** | Week 1 → Month 1 → Month 2-3 expected outcomes |
| **Why ELYVN** | Traditional receptionist ($3K/mo) vs ELYVN ($299/mo) comparison |
| **FAQ** | 6 common questions with expandable answers |
| **Final CTA** | "Book a Free Demo Call" → Cal.com scheduling |

### Visual Effects

- **WebGL liquid background** — Perlin noise-based fragment shader, mouse-reactive
- **Three.js hero** — 3 wireframe torus rings + icosahedron + 400-point dot field, IntersectionObserver-optimized
- **GSAP ScrollTrigger** — Section eyebrow wipes, title slide-ups, grid wave animations, 3D pricing card tilt, elastic CTA entrance
- **Scroll progress bar** — 1px white bar at top of viewport

### File Structure

```
ELYVN-Website/
├── index.html      # Single-page HTML (all sections)
├── styles.css      # Full design system (~1100 lines)
├── app.js          # Three.js + WebGL + GSAP animations (~460 lines)
├── icon.png        # Favicon
└── README.md       # This file
```

---

## Pricing

| Plan | Price | Includes |
|------|-------|----------|
| **Starter** | $299/mo | AI Phone Agent, SMS Auto-Reply, Missed Call Text-Back, Telegram Alerts, 500 calls/month |
| **Growth** | $499/mo | Everything in Starter + Follow-Up Sequences, AI Brain + Lead Scoring, Weekly Revenue Reports, 1,500 calls/month |
| **Scale** | $799/mo | Everything in Growth + New Customer Finder, Automated Outreach, Unlimited calls, Priority Support |

All plans include a 7-day free trial. No contracts. Cancel anytime.

---

## Supported Industries

ELYVN ships with 11 pre-built niche templates, each with custom knowledge bases, call scripts, and follow-up sequences:

- Dental Offices
- Medical Spas
- Hair Salons / Barbershops
- HVAC Companies
- Plumbing Services
- Roofing Contractors
- Auto Repair Shops
- Chiropractic Clinics
- Veterinary Practices
- Fitness Studios / Gyms
- Real Estate Agencies

---

## Deployment

### Website (Vercel)

This repo auto-deploys to Vercel on push to `master`.

- **URL:** [elyvn.net](https://elyvn.net)
- **Build:** None required (static files)
- **Framework:** None (static HTML)

### Backend (Railway)

The ELYVN backend is a separate repo deployed on Railway.

- **URL:** [api.elyvn.net](https://api.elyvn.net)
- **Runtime:** Node.js 18+
- **Database:** SQLite (file-based, persisted on Railway volume)

---

## Environment Variables (Backend)

| Variable | Purpose |
|----------|---------|
| `JWT_SECRET` | Token signing key |
| `RETELL_API_KEY` | Retell AI voice agent |
| `TWILIO_ACCOUNT_SID` | Twilio SMS |
| `TWILIO_AUTH_TOKEN` | Twilio auth |
| `TELNYX_API_KEY` | Telnyx SMS fallback |
| `STRIPE_SECRET_KEY` | Stripe billing |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook verification |
| `ANTHROPIC_API_KEY` | Claude API for Brain |
| `CALCOM_API_KEY` | Cal.com booking |
| `TELEGRAM_BOT_TOKEN` | Telegram notifications |
| `GOOGLE_PLACES_API_KEY` | Business enrichment |

---

## Development

```bash
# Website (this repo) — just open index.html or use any static server
npx serve .

# Backend (separate repo)
npm install
npm start          # Production
npm run dev        # Development with nodemon
```

---

## Contact

**Sohan** — Founder
Email: ssohangowda@gmail.com
Book a demo: [cal.com/elyvn/quick](https://cal.com/elyvn/quick)

---

Built with Retell AI, Claude, Twilio, and a lot of late nights.
