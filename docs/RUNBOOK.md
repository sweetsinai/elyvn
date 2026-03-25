# ELYVN Bridge Operational Runbook

Operational procedures for deploying, maintaining, and troubleshooting the ELYVN bridge server.

---

## Table of Contents

1. [Deployment](#deployment)
2. [Health Checks](#health-checks)
3. [Rollback](#rollback)
4. [Common Operations](#common-operations)
5. [Troubleshooting](#troubleshooting)
6. [Database Management](#database-management)
7. [Environment Configuration](#environment-configuration)
8. [Monitoring & Alerting](#monitoring--alerting)

---

## Deployment

### Prerequisites

- Node.js 20+ installed
- SQLite 3.x or PostgreSQL (if migrating)
- Environment variables configured (.env file)
- Retell AI, Twilio, Cal.com, and Telegram API credentials

### First-Time Deployment

#### 1. Clone Repository
```bash
git clone <repository-url>
cd elyvn-push/server/bridge
```

#### 2. Install Dependencies
```bash
npm install
```

#### 3. Create Environment File
```bash
cp .env.example .env
# Edit .env with your configuration (see Environment Variables section)
nano .env
```

#### 4. Initialize Database
```bash
# Database migrations run automatically on startup
# This creates all required tables and indexes
npm start
```

Check logs for: `[db] SQLite connected: /path/to/elyvn.db (WAL mode, 64MB cache, FK enforced)`

#### 5. Verify Health
```bash
curl http://localhost:3001/health
```

Should return status: `"ok"` with all services connected.

#### 6. Test Webhook Endpoints
- Verify Retell webhook receives calls
- Test Twilio SMS delivery
- Confirm Cal.com bookings are captured
- Check Telegram bot responds to /start

### Docker Deployment (Railway)

The project uses nixpacks for deployment:

```bash
# nixpacks.toml configures:
# - Node.js 20 installation
# - npm install in server/bridge directory
# - Start command: cd server/bridge && node index.js

# Deploy via Railway:
railway up
```

### Scaled Deployment (Multiple Instances)

For high availability, run multiple bridge instances behind a load balancer:

```bash
# Instance 1 (Port 3001)
PORT=3001 npm start

# Instance 2 (Port 3002)
PORT=3002 npm start

# Nginx reverse proxy (upstream.conf)
upstream elyvn_bridge {
  server localhost:3001;
  server localhost:3002;
  server localhost:3003;
}
```

**Note:** SQLite database file must be shared across instances (use network storage like NFS or switch to PostgreSQL).

### Zero-Downtime Deployment

```bash
# 1. Deploy new version to canary instance
PORT=3003 npm start  # Test with 5% traffic

# 2. Monitor canary for 5 minutes
curl -H "x-api-key: KEY" http://localhost:3003/health

# 3. If healthy, shift traffic to new instances
#    (via load balancer or DNS)

# 4. Stop old instances
kill <old-process-pid>

# 5. Verify no errors in logs
tail -f logs/elyvn-bridge.log | grep ERROR
```

---

## Health Checks

### Basic Health Endpoint
```bash
curl http://localhost:3001/health
```

**Expected Response:**
```json
{
  "status": "ok",
  "timestamp": "2025-03-25T10:30:45Z",
  "uptime_seconds": 3600,
  "database": {
    "status": "connected",
    "adapter": "sqlite",
    "size_mb": 45.2
  },
  "db_counts": {
    "calls": 1250,
    "leads": 340,
    "pending_jobs": 5
  }
}
```

**Status Values:**
- `"ok"` - All systems healthy
- `"degraded"` - Database connected but issues detected
- Error response or timeout - Critical failure

### Database Health Check

```bash
# Connect to SQLite
sqlite3 /path/to/elyvn.db

# Run integrity check
.integrity_check
```

Should return: `ok` (no corrupted data)

### Performance Metrics
```bash
# Get internal metrics (auth required)
curl -H "x-api-key: YOUR_KEY" http://localhost:3001/metrics
```

Returns: Request counts, error rates, response times by endpoint

### External Service Connectivity

```bash
# Check Retell API
curl -H "Authorization: Bearer $RETELL_API_KEY" \
  https://api.retellai.com/v2/get-agent/AGENT_ID

# Check Twilio
curl -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" \
  https://api.twilio.com/2010-04-01/Accounts.json

# Check Cal.com
curl -H "Authorization: Bearer $CALCOM_API_KEY" \
  https://api.cal.com/v1/bookings

# Check Anthropic (for email classification)
curl -H "x-api-key: $ANTHROPIC_API_KEY" \
  https://api.anthropic.com/v1/models
```

### Monitoring Checklist

Run daily:
```bash
#!/bin/bash
# health_check.sh

API_KEY="your_api_key"
BASE_URL="http://localhost:3001"

# 1. Health status
echo "=== Health Status ==="
curl -s $BASE_URL/health | jq '.status'

# 2. Database size
echo "=== Database Size ==="
curl -s -H "x-api-key: $API_KEY" $BASE_URL/health | jq '.database.size_mb'

# 3. Pending jobs
echo "=== Pending Jobs ==="
curl -s -H "x-api-key: $API_KEY" $BASE_URL/health | jq '.db_counts.pending_jobs'

# 4. Error rate (from logs)
echo "=== Recent Errors ==="
tail -100 logs/elyvn-bridge.log | grep ERROR | wc -l

# 5. Response time
echo "=== Response Time ==="
curl -w "Time: %{time_total}s\n" -o /dev/null -s $BASE_URL/health
```

---

## Rollback

### Rollback via Git

```bash
# 1. Identify last good commit
git log --oneline -10

# 2. Revert to previous version
git reset --hard <commit-hash>

# 3. Rebuild and restart
npm install
npm start
```

### Rollback via Database Snapshot

If data was corrupted during an upgrade:

```bash
# 1. Stop the service
pkill -f "node index.js"

# 2. Restore from backup
cp /backups/elyvn.db.2025-03-24 /path/to/elyvn.db

# 3. Restart
npm start
```

### Emergency Rollback (Last Resort)

If the service is unrecoverable:

```bash
# 1. Switch to last known good version
docker pull elyvn-bridge:stable-v1.2.3
docker stop elyvn-bridge
docker run -d -p 3001:3001 \
  -v /data/elyvn.db:/app/elyvn.db \
  elyvn-bridge:stable-v1.2.3

# 2. Verify it's working
curl http://localhost:3001/health

# 3. Notify stakeholders
# - Paste into #outages Slack channel
# - Create incident in PagerDuty
```

---

## Common Operations

### Adding a New Client

#### Via API (Recommended)
```bash
curl -X POST \
  -H "x-api-key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "business_name": "New Company",
    "owner_name": "Owner Name",
    "owner_phone": "+15551234567",
    "owner_email": "owner@company.com",
    "industry": "Services",
    "timezone": "America/New_York",
    "avg_ticket": 500
  }' \
  http://localhost:3001/api/clients
```

#### Via Onboarding Endpoint (Public)
```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "business_name": "New Company",
    "owner_name": "Owner Name",
    "owner_phone": "+15551234567",
    "owner_email": "owner@company.com",
    "industry": "Services",
    "services": ["Service 1", "Service 2"]
  }' \
  http://localhost:3001/api/onboard
```

Returns:
- `client_id` - Use for all API calls
- `webhook_urls` - Configure in Retell, Twilio, Cal.com, Telegram
- `embed_code` - Add to client's website for lead capture

### Restarting the Service

```bash
# Graceful restart (in-flight requests complete)
pkill -TERM -f "node index.js"

# Wait for graceful shutdown (max 30 seconds)
sleep 2

# Start again
npm start

# Force restart (if graceful hangs)
pkill -9 -f "node index.js"
npm start
```

**What happens during graceful shutdown:**
1. Stop accepting new connections
2. Wait for in-flight requests to complete (max 30s)
3. Close database connection (checkpoint WAL)
4. Exit cleanly

### Running Database Migrations

Migrations run automatically on startup. To run manually:

```bash
# Connect and check current schema
sqlite3 /path/to/elyvn.db ".schema"

# Backup before major operations
cp /path/to/elyvn.db /path/to/elyvn.db.backup

# Run migrations via code (edit migration file and restart)
npm start
```

### Clearing Job Queue

```bash
sqlite3 /path/to/elyvn.db

# View pending jobs
SELECT COUNT(*) as pending FROM job_queue WHERE status = 'pending';

# Clear all pending jobs (careful!)
DELETE FROM job_queue WHERE status = 'pending';

# Clear failed jobs older than 7 days
DELETE FROM job_queue
WHERE status IN ('failed', 'cancelled')
AND updated_at < datetime('now', '-7 days');
```

### Testing a Webhook Locally

```bash
# Send test Retell webhook
curl -X POST \
  -H "Content-Type: application/json" \
  -H "x-retell-signature: $(echo -n '{}' | openssl dgst -sha256 -hmac 'secret' -hex | cut -d' ' -f2)" \
  -d '{
    "event": "call_ended",
    "call": {
      "call_id": "test_call_123",
      "from_number": "+15551234567",
      "to_number": "+15559876543",
      "duration_secs": 120,
      "end_reason": "customer_hangup"
    }
  }' \
  http://localhost:3001/webhooks/retell

# Send test Form webhook
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "Test Lead",
    "email": "test@example.com",
    "phone": "+15551234567",
    "message": "Test message"
  }' \
  http://localhost:3001/webhooks/form
```

---

## Troubleshooting

### Service Won't Start

```bash
# 1. Check error message
npm start 2>&1 | head -50

# Common issues:
```

**Missing required env vars:**
```
[FATAL] Missing required env vars: ANTHROPIC_API_KEY
```
Solution: Add `ANTHROPIC_API_KEY=sk-...` to .env

**Port already in use:**
```
Error: listen EADDRINUSE: address already in use :::3001
```
Solution: `lsof -i :3001` then `kill -9 <PID>` or use different port `PORT=3002 npm start`

**Database locked:**
```
[server] Database connection failed: database is locked
```
Solution:
```bash
# Kill existing connections
pkill -f "node index.js"
# Or delete WAL files if corrupted
rm /path/to/elyvn.db-wal /path/to/elyvn.db-shm
```

### High Memory Usage

```bash
# Check memory status in health endpoint
curl http://localhost:3001/health | jq '.memory'

# If heapUsed > 80% of heapTotal:
# 1. Check for memory leaks in code
# 2. Increase Node.js heap size
export NODE_OPTIONS=--max-old-space-size=2048
npm start
```

### Database Corruption

```bash
# 1. Stop the service
pkill -f "node index.js"

# 2. Run integrity check
sqlite3 /path/to/elyvn.db ".integrity_check"

# If errors found:
# 3. Vacuum and rebuild
sqlite3 /path/to/elyvn.db "VACUUM; REINDEX;"

# 4. If still corrupt, restore from backup
cp /backups/elyvn.db.latest /path/to/elyvn.db

# 5. Restart
npm start
```

### Slow Queries

```bash
# Enable query logging
DATABASE_VERBOSE=true npm start

# Look for queries taking >1000ms
tail -f logs/elyvn-bridge.log | grep "1[0-9][0-9][0-9]\s*ms"

# Common slow queries:
# - Aggregating all leads (add index on client_id, stage)
# - Searching messages by body (requires LIKE, non-indexed)

# Add missing indexes:
sqlite3 /path/to/elyvn.db "CREATE INDEX IF NOT EXISTS idx_messages_client_phone ON messages(client_id, phone);"
```

### Webhooks Not Processing

```bash
# 1. Check webhook logs
tail -f logs/elyvn-bridge.log | grep "webhooks"

# 2. Test webhook connectivity
curl -v http://localhost:3001/webhooks/retell

# 3. Verify webhook signature (if enabled)
#    For Retell: Check RETELL_WEBHOOK_SECRET is set correctly
#    For Twilio: Check TWILIO_AUTH_TOKEN matches Twilio account

# 4. Check job queue processing
curl -H "x-api-key: KEY" http://localhost:3001/health | jq '.db_counts.pending_jobs'
```

### Leads Not Being Created

```bash
# 1. Check if lead creation is working via form
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "test-id",
    "name": "Test",
    "phone": "+15551234567"
  }' \
  http://localhost:3001/webhooks/form

# 2. Verify client_id exists and is active
sqlite3 /path/to/elyvn.db "SELECT * FROM clients LIMIT 1;"

# 3. Check job queue for speed_to_lead_sms jobs
sqlite3 /path/to/elyvn.db "SELECT * FROM job_queue WHERE type LIKE 'speed%' LIMIT 5;"

# 4. Verify Twilio/Retell credentials are set
grep -E "TWILIO|RETELL" .env
```

### SMS Not Sending

```bash
# 1. Check if Twilio credentials are configured
env | grep TWILIO

# 2. Test Twilio API directly
curl -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" \
  -X POST https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/Messages.json \
  -d "To=+15551234567&From=$TWILIO_PHONE_NUMBER&Body=Test"

# 3. Check job queue for SMS jobs
sqlite3 /path/to/elyvn.db "SELECT * FROM job_queue WHERE type LIKE '%sms%' AND status != 'completed' LIMIT 10;"

# 4. Check SMS logs
tail -f logs/elyvn-bridge.log | grep "sms\|SMS\|twilio\|Twilio"
```

### AI Callback Not Triggering

```bash
# 1. Verify Retell credentials
env | grep RETELL

# 2. Check if speed_to_lead_callback jobs are in queue
sqlite3 /path/to/elyvn.db "SELECT * FROM job_queue WHERE type = 'speed_to_lead_callback' LIMIT 5;"

# 3. Check if client has retell_agent_id configured
sqlite3 /path/to/elyvn.db "SELECT retell_agent_id, retell_phone FROM clients LIMIT 1;"

# 4. Check job execution logs
tail -f logs/elyvn-bridge.log | grep "speed_to_lead_callback"
```

---

## Database Management

### Backup Procedures

#### Automated Daily Backups

Backups run automatically every 24 hours. Configured in `utils/backup.js`:

```bash
# Backups are stored in: /backups/elyvn.db.YYYY-MM-DD-HH-MM-SS

# List recent backups
ls -lh /backups/elyvn.db.* | tail -10

# Verify backup integrity
sqlite3 /backups/elyvn.db.2025-03-24-02-00-00 ".integrity_check"
```

#### Manual Backup
```bash
# Create backup
cp /path/to/elyvn.db /backups/elyvn.db.$(date +%s).bak

# Compressed backup (saves space)
gzip -c /path/to/elyvn.db > /backups/elyvn.db.$(date +%Y-%m-%d).gz
```

#### Upload Backup to Cloud
```bash
# S3 example
aws s3 cp /path/to/elyvn.db s3://my-bucket/backups/elyvn.db.$(date +%Y-%m-%d)

# Google Cloud Storage example
gsutil cp /path/to/elyvn.db gs://my-bucket/backups/elyvn.db.$(date +%Y-%m-%d)
```

### Restore Procedures

#### From Backup
```bash
# 1. Stop the service
pkill -f "node index.js"

# 2. Restore
cp /backups/elyvn.db.2025-03-24 /path/to/elyvn.db

# 3. Verify
sqlite3 /path/to/elyvn.db ".integrity_check"

# 4. Start service
npm start
```

### Data Retention

Old data is automatically deleted based on retention policy (configured in `utils/dataRetention.js`):

```bash
# Current retention policy:
# - Calls older than 90 days
# - Messages older than 60 days
# - Leads in 'lost' stage older than 30 days

# View retention settings
grep -r "dataRetention\|retention" utils/

# Manual data cleanup
sqlite3 /path/to/elyvn.db

# Delete calls older than 90 days
DELETE FROM calls WHERE created_at < datetime('now', '-90 days');

# Delete messages older than 60 days
DELETE FROM messages WHERE created_at < datetime('now', '-60 days');

# Delete lost leads older than 30 days
DELETE FROM leads WHERE stage = 'lost' AND created_at < datetime('now', '-30 days');

# Vacuum to reclaim space
VACUUM;
```

### Database Inspection

```bash
# Connect to SQLite
sqlite3 /path/to/elyvn.db

# List all tables
.tables

# Check table schema
.schema calls
.schema messages
.schema leads

# View table sizes
SELECT name,
  ROUND((SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()) / 1024 / 1024.0, 2) as size_mb
FROM sqlite_master
WHERE type='table'
ORDER BY size_mb DESC;

# Count records
SELECT 'calls' as table_name, COUNT(*) as count FROM calls
UNION ALL
SELECT 'messages', COUNT(*) FROM messages
UNION ALL
SELECT 'leads', COUNT(*) FROM leads
UNION ALL
SELECT 'job_queue', COUNT(*) FROM job_queue;

# Find orphaned records (leads with no corresponding calls)
SELECT l.* FROM leads l
LEFT JOIN calls c ON l.client_id = c.client_id AND l.phone = c.caller_phone
WHERE c.id IS NULL AND l.created_at < datetime('now', '-7 days');
```

---

## Environment Configuration

### Required Environment Variables

```bash
# Core
ANTHROPIC_API_KEY=sk-...              # Anthropic API key (required)
NODE_ENV=production                    # production | development | test
PORT=3001                              # Server port
DATABASE_PATH=/path/to/elyvn.db       # SQLite database path

# Retell AI
RETELL_API_KEY=...                    # API key for Retell
RETELL_WEBHOOK_SECRET=...             # Optional: webhook signature verification

# Twilio (SMS)
TWILIO_ACCOUNT_SID=AC...              # Account SID
TWILIO_AUTH_TOKEN=...                 # Auth token
TWILIO_PHONE_NUMBER=+1...             # Sender phone number

# Cal.com (Bookings)
CALCOM_API_KEY=...                    # API key
CALCOM_BOOKING_LINK=https://...       # Default booking link

# Telegram Bot
TELEGRAM_BOT_TOKEN=...                # Bot token (optional)
TELEGRAM_WEBHOOK_SECRET=...           # Optional: webhook secret

# SMTP (Email)
SMTP_HOST=smtp.gmail.com              # SMTP server
SMTP_PORT=587                         # SMTP port
SMTP_USER=...                         # Email account
SMTP_PASS=...                         # Email password
SMTP_SECURE=true                      # Use TLS

# Google Places API (for prospect scraping)
GOOGLE_MAPS_API_KEY=...               # Maps/Places API key

# Security
ELYVN_API_KEY=...                     # Global admin API key (strongly recommended)
CORS_ORIGINS=https://yourdomain.com  # Comma-separated allowed origins

# Deployment (Railway)
RAILWAY_PUBLIC_DOMAIN=app.railway.app # Railroad domain (auto-set)
BASE_URL=https://yourdomain.com       # Fallback base URL
```

### Optional Environment Variables

```bash
# Email sending
EMAIL_DAILY_LIMIT=300                 # Max emails per day
OUTREACH_SENDER_NAME=Your Name        # Default sender name

# Data retention
RETENTION_ENABLED=true                # Enable auto-cleanup
CALL_RETENTION_DAYS=90                # Delete calls older than N days
MESSAGE_RETENTION_DAYS=60             # Delete messages older than N days

# Logging
LOG_LEVEL=info                        # debug | info | warn | error
LOG_FILE=/var/log/elyvn-bridge.log    # Log file path (optional)

# Performance
MAX_POOL_SIZE=10                      # DB connection pool size
REQUEST_TIMEOUT=30000                 # Request timeout in ms
```

### Example .env File

```bash
# .env
NODE_ENV=production
PORT=3001
DATABASE_PATH=/data/elyvn.db

# APIs
ANTHROPIC_API_KEY=sk-ant-v7-...
RETELL_API_KEY=...
TWILIO_ACCOUNT_SID=ACxxxxx
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+15551234567
CALCOM_API_KEY=...
TELEGRAM_BOT_TOKEN=...
GOOGLE_MAPS_API_KEY=...

# Email
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_USER=apikey
SMTP_PASS=SG.xxxxx
SMTP_SECURE=true

# Security
ELYVN_API_KEY=sk-key-very-secure-string-here
CORS_ORIGINS=https://yourdomain.com,https://app.yourdomain.com

# Deployment
RAILWAY_PUBLIC_DOMAIN=elyvn-app.railway.app
BASE_URL=https://api.yourdomain.com
```

---

## Monitoring & Alerting

### Logging

Logs are written to both console and file:

```bash
# View real-time logs
tail -f logs/elyvn-bridge.log

# Filter by level
tail -f logs/elyvn-bridge.log | grep ERROR
tail -f logs/elyvn-bridge.log | grep WARN

# Search by component
tail -f logs/elyvn-bridge.log | grep "\[retell\]"
tail -f logs/elyvn-bridge.log | grep "\[twilio\]"
tail -f logs/elyvn-bridge.log | grep "\[jobQueue\]"

# Count errors over time
grep ERROR logs/elyvn-bridge.log | wc -l
```

### Alert Thresholds

Monitor these metrics and alert if:

| Metric | Threshold | Action |
|--------|-----------|--------|
| Health status | != "ok" | Page on-call engineer |
| Pending jobs | > 100 | Check job queue, restart if stuck |
| Database size | > 1GB | Plan migration or archival |
| Error rate | > 5% | Review logs, identify root cause |
| Response time p95 | > 5s | Check database load, slow queries |
| Memory usage | > 85% | Increase heap size or restart |
| Database locked | persists | Kill stale connections, restart |

### Metrics to Export

```bash
# Prometheus-compatible metrics endpoint
curl -H "x-api-key: KEY" http://localhost:3001/metrics

# Key metrics:
# - elyvn_calls_total (counter)
# - elyvn_leads_created_total (counter)
# - elyvn_sms_sent_total (counter)
# - elyvn_callback_attempts_total (counter)
# - elyvn_api_requests_total (counter by endpoint)
# - elyvn_request_duration_seconds (histogram)
# - elyvn_database_size_bytes (gauge)
# - elyvn_pending_jobs (gauge)
```

### Setting Up Alerts in Your Monitoring System

**Example: Datadog**
```yaml
# datadog-monitors.yaml
- name: "ELYVN Bridge - Health Check Failed"
  type: service_check
  query: 'checkAlert(elyvn.health)'
  alert_type: no_data
  no_data_timeframe: 300
  notify: ["@slack-oncall"]
```

**Example: Prometheus + AlertManager**
```yaml
# prometheus-rules.yml
groups:
- name: elyvn_alerts
  rules:
  - alert: ELYVNHealthFailed
    expr: elyvn_health_status != 1
    for: 2m
    annotations:
      summary: "ELYVN health check failed"
```

---

## Incident Response

### On-Call Rotation

Set up a rotating on-call schedule using PagerDuty, Opsgenie, or similar.

### Incident Notification Template

```
🚨 INCIDENT: ELYVN Bridge Down
- Start time: 2025-03-25 14:32 UTC
- Service: API, webhooks, database
- Status: Investigating
- Action: Check health endpoint, verify database, review recent deploys
- On-call: @person
- Update frequency: Every 15 minutes
```

### Post-Incident Review

After resolving an incident:

1. **Timeline** - What happened and when
2. **Impact** - How many users/requests affected
3. **Root cause** - Why did it happen
4. **Fix** - What was done to resolve
5. **Prevention** - What changes prevent recurrence
6. **Postmortems** - Document in wiki/docs/postmortems/

---

## Maintenance Windows

### Planned Maintenance

Schedule maintenance during low-traffic windows (e.g., 2-4 AM UTC):

```bash
# 1. Announce maintenance (Slack, email)
MAINTENANCE_WINDOW="2025-03-26 02:00 UTC - 04:00 UTC"

# 2. Run backups
npm run backup

# 3. Deploy new version (zero-downtime if possible)
git pull origin main
npm install
npm start

# 4. Verify health
curl http://localhost:3001/health

# 5. Clear any stuck jobs
sqlite3 /path/to/elyvn.db "UPDATE job_queue SET status = 'failed' WHERE status = 'processing' AND updated_at < datetime('now', '-1 hour');"

# 6. Announce completion
echo "✅ Maintenance complete. All systems normal."
```

---

## Support & Escalation

**Technical Issues:**
1. Check logs: `tail -f logs/elyvn-bridge.log`
2. Verify health: `curl http://localhost:3001/health`
3. Check database: `sqlite3 /path/to/elyvn.db ".integrity_check"`
4. Escalate to on-call engineer if unresolved in 15 minutes

**Customer Issues:**
1. Check client status: `curl -H "x-api-key: KEY" http://localhost:3001/health`
2. Verify webhooks are being processed: Check job queue count
3. Test a manual action (e.g., send SMS) to isolate issue
4. Contact customer with status and ETA

**Urgent Security Issue:**
1. Isolate affected instance if possible
2. Page on-call security engineer
3. Create incident in tracking system
4. Do not publicly disclose until fix is verified
