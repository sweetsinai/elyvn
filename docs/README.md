# ELYVN Bridge Documentation

Complete technical documentation for the ELYVN AI Receptionist Bridge server.

## Quick Navigation

### 1. **API_DOCS.md** (19 KB)
Complete API reference for developers and integrators.

**Contents:**
- Authentication & Authorization (API keys, webhook signatures)
- Rate limiting policies
- Public endpoints (health, onboarding)
- Protected API endpoints (calls, leads, messages, bookings, clients, stats)
- Webhook endpoints (Retell, Twilio, Cal.com, Telegram, Forms)
- Email tracking (open pixels, click redirects)
- Outreach API (prospect scraping, campaigns, auto-classification)
- Error handling and status codes
- Curl examples for all major operations

**Use this when:**
- Building client applications or integrations
- Configuring webhooks from external services
- Implementing API-based workflows
- Debugging webhook or API issues

---

### 2. **RUNBOOK.md** (22 KB)
Operational procedures for deployment, maintenance, and troubleshooting.

**Contents:**
- First-time deployment steps
- Docker/Railway deployment configuration
- Zero-downtime deployment procedures
- Health checks and monitoring
- Rollback procedures
- Common operations (add client, restart service, clear job queue)
- Comprehensive troubleshooting guide
- Database backup/restore procedures
- Environment variable reference
- Performance optimization tips
- Incident response procedures

**Use this when:**
- Deploying the service to production
- Troubleshooting runtime issues
- Performing routine maintenance
- Responding to incidents
- Configuring monitoring and alerts

---

### 3. **ARCHITECTURE.md** (36 KB)
System design, technology choices, and data flow documentation.

**Contents:**
- High-level system architecture diagram
- Component responsibilities (routes, business logic, data access, integrations)
- Data models and database schema
- Complete data flow examples:
  - Lead lifecycle (new → contacted → qualified → booked → completed/lost)
  - Speed-to-lead sequence (SMS → callback → follow-up)
  - Email campaign flow
  - Call processing with AI analysis
- Technology stack and why each was chosen
- Security model (authentication, authorization, data protection)
- Scaling strategies (horizontal, vertical)
- Performance targets and metrics
- Design decision rationales
- Future architecture improvements

**Use this when:**
- Understanding system design and flow
- Planning integrations or extensions
- Evaluating scaling needs
- Reviewing security model
- Making architectural decisions
- Onboarding new engineers

---

## Quick Start

### For API Users
1. Start with **API_DOCS.md** - Authentication & Public Endpoints
2. See curl examples for your use case
3. Review error codes and response formats

### For Operators
1. Review **RUNBOOK.md** - Deployment section
2. Configure environment variables
3. Run health checks
4. Set up monitoring

### For Engineers
1. Read **ARCHITECTURE.md** - System Overview
2. Review Component Architecture section
3. Understand Data Flow examples
4. Check Technology Stack rationale

---

## Key Concepts

### Lead Lifecycle
Leads flow through stages: `new` → `contacted` → `qualified` → `booked` → `completed`

Each stage has automatic actions (SMS, callbacks, emails) that trigger based on engagement.

### Speed-to-Lead Sequence
When a lead enters the system, an automated 5-touch sequence executes:
1. **Touch 1 (0s)**: SMS with booking link
2. **Touch 2 (60s)**: AI callback attempt via Retell
3. **Touch 3 (5m)**: Follow-up SMS if not booked
4. **Touch 4 (24h)**: Follow-up email for qualified leads
5. **Touch 5 (72h)**: Final follow-up email

### Job Queue
Asynchronous tasks (SMS, callbacks, emails) are queued in the database and processed every 15 seconds. Jobs support:
- Scheduling (run at specific time)
- Retries (automatic with exponential backoff)
- Persistence (survives server restarts)
- Idempotency (safe to retry failed jobs)

### Webhook Integration
External services send webhooks when events occur:
- **Retell**: Call started, ended, analyzed
- **Twilio**: SMS received
- **Cal.com**: Appointment booked, cancelled, rescheduled
- **Telegram**: Bot messages and button clicks
- **Forms**: Lead submissions from web forms

---

## Deployment Checklist

- [ ] Copy `.env.example` to `.env`
- [ ] Set required environment variables (ANTHROPIC_API_KEY, RETELL_API_KEY, etc.)
- [ ] Run `npm install` in `server/bridge`
- [ ] Start with `npm start` and verify no errors
- [ ] Test health endpoint: `curl http://localhost:3001/health`
- [ ] Configure webhook URLs in external services (Retell, Twilio, Cal.com)
- [ ] Create first client via `POST /api/onboard`
- [ ] Test form submission, SMS, and callback flows
- [ ] Set up automated backups
- [ ] Configure monitoring and alerts

---

## Database Schema

Key tables:
- **clients** - Business configurations (Retell agent, Twilio number, booking link)
- **calls** - Voice call history with summaries and sentiment
- **messages** - SMS and chat message history
- **leads** - Prospects being qualified (stage, score, contact info)
- **job_queue** - Async tasks (SMS, callbacks, emails) waiting to execute
- **emails_sent** - Campaign email tracking (opens, clicks, replies)
- **appointments** - Calendar bookings from Cal.com
- **audit_logs** - API access and authentication events

See ARCHITECTURE.md for full schema details.

---

## Support & Troubleshooting

### Common Issues

**Service won't start:**
- Check required env vars: `ANTHROPIC_API_KEY` is mandatory
- Check database path is writable
- See RUNBOOK.md "Troubleshooting" section

**Webhooks not processing:**
- Verify webhook URLs are configured correctly in external services
- Check webhook secret is set correctly (signature verification)
- Look for "WARN" logs in server output
- Use RUNBOOK.md "Webhooks Not Processing" guide

**High memory usage:**
- Check health endpoint for memory stats
- Increase Node.js heap: `NODE_OPTIONS=--max-old-space-size=2048 npm start`
- See RUNBOOK.md "High Memory Usage" section

**Database corruption:**
- Stop service and run integrity check: `sqlite3 elyvn.db ".integrity_check"`
- Restore from backup if corrupted
- See RUNBOOK.md "Database Corruption" section

---

## File Locations

All documentation files are in `/docs/`:
- `API_DOCS.md` - API reference
- `RUNBOOK.md` - Operations guide
- `ARCHITECTURE.md` - System design
- `README.md` - This file

---

## Updates & Maintenance

Documentation should be updated when:
- New API endpoints are added
- Deployment procedures change
- Schema changes (database migrations)
- New integration is added
- Architecture decisions are made

Keep docs in sync with code to prevent confusion.

---

## Document Statistics

- **Total Documentation**: ~77 KB (3 files)
- **API_DOCS.md**: 19 KB, 500+ lines
- **RUNBOOK.md**: 22 KB, 600+ lines
- **ARCHITECTURE.md**: 36 KB, 900+ lines

Last updated: 2025-03-25
