# ELYVN Bridge Code Review

**Date:** March 2026
**Status:** Pre-production review
**Scope:** Comprehensive security, performance, and correctness audit

---

## Executive Summary

The ELYVN project demonstrates solid architectural patterns with good separation of concerns, proper webhook signature verification, and comprehensive error handling. However, there are **8 critical/high-severity issues** that must be addressed before production deployment, spanning SQL injection vulnerabilities, race conditions, JSON parsing risks, and data isolation gaps.

---

## Critical Issues

| # | File | Line | Issue | Severity |
|---|------|------|-------|----------|
| 1 | `/routes/api.js` | 479 | **SQL Injection in Dynamic Query** - User-controlled field names used directly in UPDATE statement | CRITICAL |
| 2 | `/routes/retell.js` | 327-330 | **Race Condition in Lead Upsert** - Non-atomic select-then-insert allows duplicate leads | CRITICAL |
| 3 | `/routes/twilio.js` | 287 | **Unsafe JSON.parse() on User Input** - Unhandled parse errors on Claude response | CRITICAL |
| 4 | `/index.js` | 142 | **Hash-Based API Key Comparison Timing Attack** - Direct === comparison vulnerable to timing attacks | CRITICAL |
| 5 | `/routes/api.js` | 445 | **Insufficient URL Validation** - UUID validation bypassed via query param, allows clientId override | HIGH |
| 6 | `/routes/retell.js` | 318-330 | **Missing Lead Phone Validation** - callerPhone can be null, corrupts lead records | HIGH |
| 7 | `/routes/onboard.js` | 222 | **Path Traversal Risk in KB File Path** - clientId not re-validated before filesystem write | HIGH |
| 8 | `/utils/jobQueue.js` | 166 | **SQL Injection in cancelJobs LIKE Clause** - Unsanitized filter.payloadContains parameter | HIGH |

---

## Security Issues

### 1. **SQL Injection in Dynamic UPDATE Statement**
**File:** `/routes/api.js` (Line 479)
**Severity:** CRITICAL
**Description:**
Field names in PUT /clients/:clientId are user-controlled and inserted directly into SQL UPDATE:
```javascript
db.prepare(`UPDATE clients SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
```
An attacker can craft payloads like `{"field\"); DROP TABLE clients; --": "value"}` to break the query structure.

**Suggested Fix:**
```javascript
const ALLOWED_FIELDS = [
  'business_name', 'owner_name', 'owner_phone', 'owner_email',
  'retell_agent_id', 'retell_phone', 'twilio_phone', 'industry', 'timezone',
  'calcom_event_type_id', 'calcom_booking_link', 'telegram_chat_id',
  'avg_ticket', 'is_active'
];

const setClauses = [];
const values = [];

for (const field of ALLOWED_FIELDS) {
  if (field in updates) {
    setClauses.push(`${field} = ?`); // Field is now whitelisted
    values.push(updates[field]);
  }
}

if (setClauses.length > 0) {
  setClauses.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(clientId);
  db.prepare(`UPDATE clients SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
}
```

---

### 2. **Hash-Based API Key Comparison Timing Attack**
**File:** `/index.js` (Line 141-143)
**Severity:** CRITICAL
**Description:**
API key comparison uses direct `===` after SHA-256 hash:
```javascript
const hash = crypto.createHash('sha256').update(provided).digest('hex');
if (API_KEY && provided === API_KEY) { ... } // Direct comparison, not timing-safe
const keyRecord = db.prepare(...).get(hash); // Then DB lookup
if (keyRecord) { ... } // Direct comparison here too
```
While hashing helps, the `===` operator still allows timing attacks. The fallback dev mode bypass (line 159) also lacks timing safety.

**Suggested Fix:**
```javascript
const crypto = require('crypto');

// Use timing-safe comparison
function timingSafeCompare(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

if (API_KEY && timingSafeCompare(provided, API_KEY)) {
  req.isAdmin = true;
  return next();
}

if (db) {
  try {
    const hash = crypto.createHash('sha256').update(provided).digest('hex');
    const keyRecord = db.prepare(
      "SELECT * FROM client_api_keys WHERE api_key_hash = ? AND is_active = 1 AND (expires_at IS NULL OR expires_at > datetime('now'))"
    ).get(hash);

    if (keyRecord) {
      // Hash is already verified by DB query; hash is timing-safe
      req.clientId = keyRecord.client_id;
      req.keyPermissions = JSON.parse(keyRecord.permissions || '["read","write"]');
      db.prepare("UPDATE client_api_keys SET last_used_at = datetime('now') WHERE id = ?").run(keyRecord.id);
      logAudit(db, { action: 'auth_success', clientId: keyRecord.client_id, ip: req.ip, userAgent: req.get('user-agent'), details: { key_id: keyRecord.id, path: req.path } });
      return next();
    }
  } catch (err) {
    console.error('[auth] Client key lookup error:', err.message);
  }
}
```

---

### 3. **Unsafe JSON.parse() on User-Controlled Input**
**File:** `/routes/twilio.js` (Line 287)
**Severity:** CRITICAL
**Description:**
Claude's response is parsed as JSON without error handling:
```javascript
const rawText = resp.content[0]?.text || '';
try {
  const parsed = JSON.parse(rawText);
  reply = parsed.reply || rawText;
  confidence = ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'high';
} catch (_) {
  reply = rawText;
  confidence = 'high';
}
```
If Claude returns malformed JSON or an attacker intercepts the response, invalid data flows through. The catch block silently swallows errors, but `reply` is then used without validation.

**Suggested Fix:**
```javascript
const rawText = resp.content[0]?.text || '';
let reply = '';
let confidence = 'medium';

try {
  const parsed = JSON.parse(rawText);

  // Validate structure
  if (typeof parsed === 'object' && parsed !== null) {
    if (typeof parsed.reply === 'string' && parsed.reply.length > 0 && parsed.reply.length <= 160) {
      reply = parsed.reply;
    } else if (typeof parsed.reply === 'string') {
      reply = parsed.reply.substring(0, 160); // Truncate if needed
    }

    if (['high', 'medium', 'low'].includes(parsed.confidence)) {
      confidence = parsed.confidence;
    }
  }

  // Fallback if parsing succeeded but reply is empty
  if (!reply) {
    reply = rawText.substring(0, 160);
  }
} catch (err) {
  console.error('[twilio] JSON parse failed, using raw text:', err.message);
  reply = rawText.substring(0, 160);
  confidence = 'medium';
}
```

---

### 4. **Race Condition in Lead Upsert**
**File:** `/routes/retell.js` (Line 318-330)
**Severity:** CRITICAL
**Description:**
Lead creation uses a separate SELECT and INSERT without a transaction, causing a TOCTOU (time-of-check-time-of-use) race condition:
```javascript
const existingLead = db.prepare(
  'SELECT id FROM leads WHERE phone = ? AND client_id = ?'
).get(callerPhone, clientId);

if (existingLead) {
  db.prepare(`UPDATE leads SET ...`).run(score, ...);
} else {
  db.prepare(`INSERT INTO leads (...) VALUES (...)`).run(...);
}
```
Two concurrent webhooks for the same phone can both see no existing lead and INSERT duplicates.

**Suggested Fix:**
```javascript
// Use INSERT OR IGNORE + SELECT + UPDATE pattern, or wrap in transaction
db.transaction(() => {
  const existingLead = db.prepare(
    'SELECT id FROM leads WHERE phone = ? AND client_id = ?'
  ).get(callerPhone, clientId);

  if (existingLead) {
    db.prepare(`
      UPDATE leads SET
        score = MAX(score, ?),
        last_contact = ?,
        stage = CASE WHEN stage = 'new' THEN 'contacted' ELSE stage END,
        updated_at = ?
      WHERE id = ?
    `).run(score, new Date().toISOString(), new Date().toISOString(), existingLead.id);
  } else {
    db.prepare(`
      INSERT INTO leads (id, client_id, phone, score, stage, last_contact, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'new', ?, ?, ?)
    `).run(randomUUID(), clientId, callerPhone, score, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  }
})();
```

---

### 5. **Missing Lead Phone Validation**
**File:** `/routes/retell.js` (Line 314-335)
**Severity:** HIGH
**Description:**
`callerPhone` from webhook payload is not validated before use:
```javascript
const callerPhone = callRecord.caller_phone;
const clientId = callRecord.client_id;

if (callerPhone && clientId) {
  const existingLead = db.prepare(
    'SELECT id FROM leads WHERE phone = ? AND client_id = ?'
  ).get(callerPhone, clientId);

  if (existingLead) {
    db.prepare(`UPDATE leads SET ...`).run(score, ...); // callerPhone used without format check
  }
}
```
If Retell sends malformed phone data (empty string, null, invalid format), corrupted lead records are created. This propagates to SMS functions which expect E.164 format.

**Suggested Fix:**
```javascript
const { normalizePhone } = require('../utils/phone');
const { isValidPhone } = require('../utils/validators');

// In handleCallEnded after setting callerPhone
if (!callerPhone || !isValidPhone(callerPhone)) {
  console.warn(`[retell] Skipping lead upsert — invalid phone: ${callerPhone}`);
  return; // Do not create/update lead
}

const normalizedPhone = normalizePhone(callerPhone);
const existingLead = db.prepare(
  'SELECT id FROM leads WHERE phone = ? AND client_id = ?'
).get(normalizedPhone, clientId);
// ... rest of logic
```

---

### 6. **Insufficient URL Validation in Email Tracking**
**File:** `/index.js` (Line 196-270)
**Severity:** HIGH
**Description:**
Email click tracking validates URL format but not against SSRF attacks:
```javascript
if (!decodedUrl || (!decodedUrl.startsWith('https://') && !decodedUrl.startsWith('http://'))) {
  return res.status(400).send('Invalid redirect URL');
}
if (decodedUrl.match(/^(javascript|data|vbscript):/i)) {
  return res.status(400).send('Invalid redirect URL');
}
new URL(decodedUrl); // Constructor validation
return res.redirect(decodedUrl);
```
An attacker can craft URLs like `http://localhost:6379` or `http://169.254.169.254/` to perform SSRF attacks against internal services.

**Suggested Fix:**
```javascript
const url = new URL(decodedUrl);
const hostname = url.hostname;

// Block private/reserved ranges
const blockedRanges = [
  /^localhost$/i,
  /^127\./,
  /^::1$/,
  /^169\.254\./,     // Link-local
  /^172\.(1[6-9]|2\d|3[01])\./,  // Private
  /^192\.168\./,
  /^10\./,
  /^0\./,
];

for (const range of blockedRanges) {
  if (range.test(hostname)) {
    console.warn(`[email-tracking] SSRF attempt blocked: ${decodedUrl}`);
    return res.status(400).send('Invalid redirect URL');
  }
}

// Also check against DNS rebinding
if (hostname.endsWith('.internal') || hostname.includes('.local')) {
  return res.status(400).send('Invalid redirect URL');
}

return res.redirect(decodedUrl);
```

---

### 7. **Path Traversal Risk in Knowledge Base File Write**
**File:** `/routes/onboard.js` (Line 221-227)
**Severity:** HIGH
**Description:**
Knowledge base file path is constructed using user-provided `clientId` without re-validation:
```javascript
const kbAbsPath = path.join(__dirname, '../../mcp/knowledge_bases', `${clientId}.json`);
// Later:
await fsPromises.writeFile(kbAbsPath, JSON.stringify(knowledgeBase, null, 2));
```
Although `clientId` is validated as UUID in line 188 `const clientId = randomUUID()`, subsequent PUT requests with user-controlled `clientId` in `/routes/api.js` line 443 could exploit this:
```javascript
// In api.js PUT /clients/:clientId
const { clientId } = req.params; // User-controlled!
if (!UUID_RE.test(clientId)) return res.status(400).json({ error: 'Invalid client ID format' });
// But then updates.knowledge_base is written to:
await fsPromises.writeFile(path.join(kbDir, `${clientId}.json`), ...);
```
An attacker with a malicious UUID format (or compromised API key) could write to unexpected paths using path traversal.

**Suggested Fix:**
```javascript
const fs = require('fs');
const path = require('path');

// Whitelist and canonicalize path
const kbDir = path.resolve(__dirname, '../../mcp/knowledge_bases');
const kbPath = path.join(kbDir, `${clientId}.json`);
const canonical = path.resolve(kbPath);

// Ensure resolved path is within kbDir
if (!canonical.startsWith(kbDir)) {
  throw new Error(`[api] Attempted path traversal: ${kbPath}`);
}

await fsPromises.writeFile(canonical, JSON.stringify(updates.knowledge_base, null, 2));
```

---

### 8. **SQL Injection in cancelJobs LIKE Clause**
**File:** `/utils/jobQueue.js` (Line 164-166)
**Severity:** HIGH
**Description:**
The `payloadContains` filter is not properly escaped for LIKE:
```javascript
if (filter.payloadContains) {
  where += " AND payload LIKE ?";
  params.push(`%${filter.payloadContains}%`);
}
```
An attacker controlling `filter.payloadContains` can inject LIKE wildcards (`%` or `_`) to match unintended jobs, or exploit the payload column for injection if the payload itself is not strictly validated.

**Suggested Fix:**
```javascript
const { escapeLikePattern } = require('./validators');

if (filter.payloadContains) {
  const escaped = escapeLikePattern(filter.payloadContains);
  where += " AND payload LIKE ?";
  params.push(`%${escaped}%`);
}
```

---

## Performance Issues

| # | File | Line | Issue | Severity |
|---|------|------|-------|----------|
| 1 | `/routes/api.js` | 276-286 | **N+1 Query Pattern in Lead Retrieval** - Fetches recent calls & messages for each lead | MEDIUM |
| 2 | `/routes/telegram.js` | 183-189 | **Unbounded Lead Query** - No LIMIT on lead count aggregation | MEDIUM |
| 3 | `/index.js` | 620-673 | **Auto-classify Polling with Synchronous HTTP** - Blocks event loop, inefficient | MEDIUM |
| 4 | `/routes/api.js` | 85-89 | **Loop-based Stage Count Query** - 6 separate queries instead of single GROUP BY | LOW |

---

### Performance Issue 1: N+1 Query in Lead Retrieval
**File:** `/routes/api.js` (Line 276-286)
**Severity:** MEDIUM
**Description:**
For each lead returned, 2 additional queries fetch related calls/messages:
```javascript
const leadsWithInteractions = leads.map(lead => {
  const recentCalls = db.prepare(
    'SELECT id, call_id, duration, outcome, summary, score, created_at FROM calls WHERE client_id = ? AND caller_phone = ? ORDER BY created_at DESC LIMIT 3'
  ).all(clientId, lead.phone);

  const recentMessages = db.prepare(
    'SELECT id, direction, body, created_at FROM messages WHERE client_id = ? AND phone = ? ORDER BY created_at DESC LIMIT 3'
  ).all(clientId, lead.phone);

  return { ...lead, recent_calls: recentCalls, recent_messages: recentMessages };
});
```
With 20 leads per page, this results in 40+ queries. For 100 leads, 200+ queries.

**Suggested Fix:**
```javascript
// Fetch all recent interactions in 2 queries
const allCalls = db.prepare(`
  SELECT id, call_id, caller_phone, duration, outcome, summary, score, created_at
  FROM calls
  WHERE client_id = ? AND caller_phone IN (${leads.map(() => '?').join(',')})
  ORDER BY created_at DESC
`).all(clientId, ...leads.map(l => l.phone));

const allMessages = db.prepare(`
  SELECT id, phone, direction, body, created_at
  FROM messages
  WHERE client_id = ? AND phone IN (${leads.map(() => '?').join(',')})
  ORDER BY created_at DESC
`).all(clientId, ...leads.map(l => l.phone));

// Group by phone
const callsByPhone = {};
const messagesByPhone = {};
allCalls.forEach(c => {
  if (!callsByPhone[c.caller_phone]) callsByPhone[c.caller_phone] = [];
  if (callsByPhone[c.caller_phone].length < 3) callsByPhone[c.caller_phone].push(c);
});
allMessages.forEach(m => {
  if (!messagesByPhone[m.phone]) messagesByPhone[m.phone] = [];
  if (messagesByPhone[m.phone].length < 3) messagesByPhone[m.phone].push(m);
});

// Attach
const leadsWithInteractions = leads.map(lead => ({
  ...lead,
  recent_calls: callsByPhone[lead.phone] || [],
  recent_messages: messagesByPhone[lead.phone] || []
}));
```

---

### Performance Issue 2: Unbounded Lead Count Aggregation
**File:** `/routes/telegram.js` (Line 183-189)
**Severity:** MEDIUM
**Description:**
Lead stage counts have no limit:
```javascript
const leadCounts = db.prepare(
  `SELECT stage, COUNT(*) as c FROM leads WHERE client_id = ? AND stage NOT IN ('lost', 'completed') GROUP BY stage`
).all(client.id);
```
For a client with 100,000 leads, this COUNT(*) can be expensive. No limit on returned rows.

**Suggested Fix:**
```javascript
// Add LIMIT or use indexed fast-count
const leadCounts = db.prepare(`
  SELECT stage, COUNT(*) as c FROM leads
  WHERE client_id = ? AND stage NOT IN ('lost', 'completed')
  GROUP BY stage
  ORDER BY stage
`).all(client.id);

// Validate result size
if (leadCounts.length > 10) {
  console.warn(`[telegram] Unexpected stage count: ${leadCounts.length}. Only 6-10 stages expected.`);
}
```

---

### Performance Issue 3: Auto-Classify Polling with Synchronous HTTP
**File:** `/index.js` (Line 620-673)
**Severity:** MEDIUM
**Description:**
Every 5 minutes, a synchronous HTTP request blocks the event loop:
```javascript
setInterval(async () => {
  // ...
  const req = http.request({
    hostname: 'localhost',
    port: PORT,
    path: '/api/outreach/auto-classify',
    method: 'POST',
    // ...
  }, (res) => { /* ... */ });
  req.on('error', (err) => { /* ... */ });
  req.setTimeout(30000, () => { req.destroy(); });
  req.end();
}, 5 * 60 * 1000);
```
This uses the synchronous `http` module which blocks. Better to use `fetch()` with proper async handling.

**Suggested Fix:**
```javascript
// Use fetch instead of http.request
setInterval(async () => {
  try {
    const unclassified = db.prepare(`
      SELECT COUNT(*) as c FROM emails_sent
      WHERE reply_text IS NOT NULL AND reply_classification IS NULL
    `).get();

    if (unclassified.c > 0) {
      console.log(`[auto-classify] Found ${unclassified.c} unclassified replies, triggering...`);

      try {
        const resp = await fetch(`http://localhost:${PORT}/api/outreach/auto-classify`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(API_KEY ? { 'x-api-key': API_KEY } : {}),
          },
          signal: AbortSignal.timeout(30000),
        });

        if (!resp.ok) {
          console.error(`[auto-classify] Request failed: ${resp.status}`);
        }
      } catch (err) {
        console.error('[auto-classify] Fetch error:', err.message);
        if (captureException) captureException(err, { context: 'auto-classify' });
      }
    }
  } catch (err) {
    console.error('[auto-classify] Check error:', err.message);
    if (captureException) captureException(err, { context: 'auto-classify.periodic' });
  }
}, 5 * 60 * 1000);
```

---

### Performance Issue 4: Loop-Based Stage Count Query
**File:** `/routes/api.js` (Line 85-89)
**Severity:** LOW
**Description:**
Six separate queries fetch stage counts:
```javascript
const stages = ['new', 'contacted', 'qualified', 'booked', 'completed', 'lost'];
const leadsByStage = {};
for (const stage of stages) {
  leadsByStage[stage] = db.prepare(
    'SELECT COUNT(*) as count FROM leads WHERE client_id = ? AND stage = ?'
  ).get(clientId, stage).count;
}
```
This can be combined into a single GROUP BY query.

**Suggested Fix:**
```javascript
const stages = ['new', 'contacted', 'qualified', 'booked', 'completed', 'lost'];
const stageCounts = db.prepare(`
  SELECT stage, COUNT(*) as count FROM leads WHERE client_id = ? GROUP BY stage
`).all(clientId);

const leadsByStage = {};
for (const stage of stages) {
  leadsByStage[stage] = stageCounts.find(s => s.stage === stage)?.count || 0;
}
```

---

## Correctness Issues

| # | File | Line | Issue | Severity |
|---|------|------|-------|----------|
| 1 | `/routes/telegram.js` | 344 | **Silent Transaction Failure** - Transaction error not propagated | MEDIUM |
| 2 | `/routes/twilio.js` | 233-237 | **Recent Outbound Message Check Uses Hardcoded 5min Window** - Not configurable | MEDIUM |
| 3 | `/utils/jobQueue.js` | 95-99 | **Unsafe JSON Parse Fallback** - Keeps payload as string, handler may fail | MEDIUM |
| 4 | `/routes/api.js` | 276-286 | **Race Condition in Lead Interaction Fetch** - Lead could be deleted between query | LOW |

---

### Correctness Issue 1: Silent Transaction Failure
**File:** `/routes/telegram.js` (Line 344-364)
**Severity:** MEDIUM
**Description:**
Database transaction errors are silently swallowed:
```javascript
db.transaction(() => {
  db.prepare('UPDATE appointments SET ...').run(phone, client.id);
  const lead = db.prepare('SELECT id, name FROM leads WHERE ...').get(phone, client.id);
  if (lead) {
    db.prepare("UPDATE followups SET status = 'cancelled' ...").run(lead.id);
    db.prepare("UPDATE leads SET stage = 'completed' ...").run(lead.id);
    db.prepare(`INSERT INTO followups (...)`).run(randomUUID(), lead.id, client.id, ...);
  }
})();
```
If the transaction fails (constraint violation, DB corruption), no error is logged or reported to the user. The command response indicates success but no work was done.

**Suggested Fix:**
```javascript
try {
  db.transaction(() => {
    db.prepare('UPDATE appointments SET ...').run(phone, client.id);
    const lead = db.prepare('SELECT id, name FROM leads WHERE ...').get(phone, client.id);
    if (lead) {
      db.prepare("UPDATE followups SET status = 'cancelled' ...").run(lead.id);
      db.prepare("UPDATE leads SET stage = 'completed' ...").run(lead.id);
      db.prepare(`INSERT INTO followups (...)`).run(randomUUID(), lead.id, client.id, ...);
    }
  })();

  await telegram.sendMessage(chatId, `✅ Done for ${phone}...`);
} catch (completeErr) {
  console.error('[telegram] /complete transaction failed:', completeErr.message);
  await telegram.sendMessage(chatId, 'Error marking job complete. Try again.');
}
```

---

### Correctness Issue 2: Hardcoded Rate Limit Window
**File:** `/routes/twilio.js` (Line 233-237)
**Severity:** MEDIUM
**Description:**
Rate limit check hardcodes 5-minute window:
```javascript
const recentOutbound = db.prepare(
  "SELECT COUNT(*) as c FROM messages WHERE phone = ? AND direction = 'outbound' AND created_at >= datetime('now','-5 minutes')"
).get(from);
if (recentOutbound.c > 0) {
  console.log(`[twilio] Rate limited outbound to ${from} — already replied within 5 min`);
  return;
}
```
This is not configurable per-client. Some clients may want 1 minute, others 15 minutes.

**Suggested Fix:**
```javascript
// Add configurable rate limit window to clients table
const client = db.prepare('SELECT * FROM clients WHERE twilio_phone = ? OR retell_phone = ?').get(to, to);
const rateLimitMinutes = client?.sms_rate_limit_minutes || 5;

const recentOutbound = db.prepare(
  `SELECT COUNT(*) as c FROM messages WHERE phone = ? AND direction = 'outbound'
   AND created_at >= datetime('now', '-' || ? || ' minutes')`
).get(from, rateLimitMinutes);

if (recentOutbound.c > 0) {
  console.log(`[twilio] Rate limited outbound to ${from} — already replied within ${rateLimitMinutes} min`);
  return;
}
```

---

### Correctness Issue 3: Unsafe JSON Parse Fallback in Job Queue
**File:** `/utils/jobQueue.js` (Line 94-99)
**Severity:** MEDIUM
**Description:**
If JSON parse fails, payload is kept as string but handlers expect objects:
```javascript
let payload = job.payload;
if (typeof payload === 'string') {
  try {
    payload = JSON.parse(payload);
  } catch (_) {
    // Keep as string if parse fails — but handler will fail!
  }
}
await executeWithTimeout(() => handler(payload, job.id, db), JOB_HANDLER_TIMEOUT);
```
If a handler expects `payload.phone` but receives a string, it will fail with `TypeError: Cannot read property 'phone' of string`. The error will be caught but the job will be retried indefinitely.

**Suggested Fix:**
```javascript
let payload = job.payload;
if (typeof payload === 'string') {
  try {
    payload = JSON.parse(payload);
  } catch (parseErr) {
    console.error(`[jobQueue] Failed to parse payload for job ${job.id}:`, parseErr.message);
    // Mark as permanently failed due to corrupted payload
    db.prepare(
      "UPDATE job_queue SET status = 'failed', error = ?, failed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
    ).run(`JSON parse failed: ${parseErr.message}`, job.id);
    continue;
  }
}

// Validate payload structure
if (typeof payload !== 'object' || payload === null) {
  console.error(`[jobQueue] Invalid payload type for job ${job.id}: ${typeof payload}`);
  db.prepare(
    "UPDATE job_queue SET status = 'failed', error = ?, failed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  ).run('Payload is not an object', job.id);
  continue;
}

await executeWithTimeout(() => handler(payload, job.id, db), JOB_HANDLER_TIMEOUT);
```

---

## Error Handling Issues

| # | File | Line | Issue | Severity |
|---|------|------|-------|----------|
| 1 | `/routes/retell.js` | 217-219 | **Silent Catch Block Swallows All Errors** - DB update failures unlogged | MEDIUM |
| 2 | `/index.js` | 217-219 | **Silent DB Failure in Email Tracking** - Update errors ignored | MEDIUM |
| 3 | `/routes/api.js` | 157-160 | **Unhandled API Error in Transcript Fetch** - No retry or fallback | LOW |

---

### Error Handling Issue 1: Silent Catch in call_analyzed
**File:** `/routes/retell.js` (Line 217-219)
**Severity:** MEDIUM
**Description:**
Database update in `handleCallAnalyzed` uses silent catch:
```javascript
try {
  if (db) {
    db.prepare("UPDATE emails_sent SET opened_at = COALESCE(opened_at, ?), ...").run(emailId);
  }
} catch (_) {
  // Silently fail if email not found or DB error
}
```
Legitimate errors (constraint violations, disk full, permissions) are silently ignored, making debugging difficult.

**Suggested Fix:**
```javascript
try {
  if (db) {
    db.prepare("UPDATE calls SET transcript = ..., updated_at = ? WHERE call_id = ?")
      .run(transcriptText, new Date().toISOString(), callId);
  }
} catch (err) {
  if (err.message.includes('UNIQUE constraint failed')) {
    console.warn(`[retell] Duplicate call record for ${callId} — this may indicate webhook retry`);
  } else {
    console.error('[retell] call_analyzed update failed:', err.message);
    if (captureException) captureException(err, { context: 'call_analyzed', callId });
  }
}
```

---

### Error Handling Issue 2: Silent DB Failure in Email Tracking
**File:** `/index.js` (Line 213-219)
**Severity:** MEDIUM
**Description:**
Email open/click tracking silently ignores DB errors:
```javascript
try {
  if (db) {
    db.prepare("UPDATE emails_sent SET opened_at = COALESCE(opened_at, ?), ...").run(...);
  }
} catch (_) {
  // Silently fail if email not found or DB error
}
```
This makes it impossible to detect DB corruption, permissions issues, or table schema problems.

**Suggested Fix:**
```javascript
try {
  if (db) {
    const result = db.prepare(
      "UPDATE emails_sent SET opened_at = COALESCE(opened_at, ?), open_count = COALESCE(open_count, 0) + 1, updated_at = ? WHERE id = ?"
    ).run(new Date().toISOString(), new Date().toISOString(), emailId);

    if (result.changes === 0) {
      console.debug(`[email-tracking] Email ID ${emailId} not found (may be old tracking link)`);
    }
  }
} catch (err) {
  console.error('[email-tracking] Database error:', err.message);
  // Still return pixel — don't fail the response
}
```

---

## Code Quality Issues

| # | File | Line | Issue | Severity |
|---|------|------|-------|----------|
| 1 | `/routes/retell.js` | 205-210 | **Transcript Type Conversion Too Permissive** - Handles string, array, JSON without validation | MEDIUM |
| 2 | `/index.js` | 98-114 | **Rate Limiter State Not Cleaned on Server Shutdown** - Memory leak potential | LOW |
| 3 | `/routes/telegram.js` | 7-34 | **Callback Rate Limiter Not Cleaned Properly** - O(n) cleanup in hot path | LOW |
| 4 | `/routes/forms.js` | 64-65 | **Field Name Aliases Not Exhaustive** - May miss valid form field variations | LOW |

---

### Code Quality Issue 1: Overly Permissive Transcript Parsing
**File:** `/routes/retell.js` (Line 205-210)
**Severity:** MEDIUM
**Description:**
Transcript conversion lacks validation:
```javascript
const transcriptText = typeof transcript === 'string'
  ? transcript
  : Array.isArray(transcript)
    ? transcript.map(t => `${t.role}: ${t.content}`).join('\n')
    : JSON.stringify(transcript);
```
If `t.role` or `t.content` are missing or non-strings, the output will be malformed. No schema validation.

**Suggested Fix:**
```javascript
const transcriptText = typeof transcript === 'string'
  ? transcript
  : Array.isArray(transcript)
    ? transcript
        .filter(t => typeof t === 'object' && t !== null && typeof t.role === 'string' && typeof t.content === 'string')
        .map(t => `${t.role}: ${t.content}`)
        .join('\n')
    : JSON.stringify(transcript);

if (!transcriptText || transcriptText.length === 0) {
  console.warn('[retell] Transcript empty or invalid format');
}
```

---

### Code Quality Issue 2: Rate Limiter State Cleanup on Shutdown
**File:** `/index.js` (Line 98-119)
**Severity:** LOW
**Description:**
Rate limiter Map grows unbounded in memory:
```javascript
const { BoundedRateLimiter } = require('./utils/rateLimiter');
const limiter = new BoundedRateLimiter({ windowMs: 60000, maxRequests: 120, maxEntries: 10000 });
// ...
setInterval(() => limiter.cleanup(), 5 * 60 * 1000);
```
If `maxEntries` is exceeded, older entries are evicted, but there's no explicit cleanup on shutdown.

**Suggested Fix:**
```javascript
const { onShutdown } = require('./utils/gracefulShutdown');
onShutdown(() => {
  console.log('[server] Cleaning up rate limiter...');
  limiter.cleanup();
});
```

---

### Code Quality Issue 3: Callback Rate Limiter O(n) Cleanup
**File:** `/routes/telegram.js` (Line 27-32)
**Severity:** LOW
**Description:**
Callback rate limiter cleanup is O(n) on every cleanup interval:
```javascript
if (callbackRateLimits.size > 10000) {
  for (const [k, v] of callbackRateLimits) {
    if (now - Math.max(...v.timestamps) > CALLBACK_RATE_WINDOW) callbackRateLimits.delete(k);
  }
}
```
The `Math.max(...v.timestamps)` call iterates over all timestamps for each key. With high traffic, this can block the event loop.

**Suggested Fix:**
```javascript
if (callbackRateLimits.size > 10000) {
  const threshold = now - CALLBACK_RATE_WINDOW;
  for (const [k, v] of callbackRateLimits) {
    // Check if most recent timestamp (last in array after filter) is old
    if (v.timestamps.length > 0 && v.timestamps[v.timestamps.length - 1] < threshold) {
      callbackRateLimits.delete(k);
    }
  }
}
```

---

## Security Best Practices Not Followed

| # | Issue | Recommendation |
|---|-------|-----------------|
| 1 | **No CSRF Protection** | Add `csrf-protection` middleware for state-changing endpoints |
| 2 | **Hardcoded Secrets in Code** | Move all `.env` references to config validation at startup |
| 3 | **No Request/Response Logging for Audit** | All external API calls should log request/response metadata |
| 4 | **No Rate Limiting on Form Submissions** | Form webhook has simple rate limiter but no per-email rate limit |
| 5 | **Missing Content-Security-Policy Headers** | Add CSP headers to prevent XSS in JSON responses |

---

## Recommendations Summary

### Before Production:
1. **Apply all CRITICAL fixes** (SQL injection, timing attacks, race conditions)
2. **Fix all HIGH issues** (URL validation, phone validation, path traversal)
3. **Implement N+1 query fixes** for performance at scale
4. **Add comprehensive logging** for security audit trails
5. **Load test** at 10x expected traffic to verify job queue and database performance

### Post-Production:
1. Set up continuous monitoring for slow queries (>100ms)
2. Implement synthetic tests for webhook signature verification
3. Add alerts for unusual auth failure patterns
4. Regular security scanning of dependencies (npm audit)
5. Monthly review of audit logs for anomalies

---

## Files Affected Summary

- `/server/bridge/index.js` — 4 issues (timing attack, SSRF, email tracking, auto-classify)
- `/server/bridge/routes/api.js` — 3 issues (SQL injection, N+1 queries, loop-based counts)
- `/server/bridge/routes/retell.js` — 4 issues (race condition, phone validation, transcript parsing, silent catch)
- `/server/bridge/routes/twilio.js` — 2 issues (JSON parse, rate limit window)
- `/server/bridge/routes/onboard.js` — 1 issue (path traversal)
- `/server/bridge/routes/telegram.js` — 3 issues (silent transaction, callback cleanup, lead count)
- `/server/bridge/utils/jobQueue.js` — 2 issues (SQL injection in LIKE, unsafe parse fallback)

---

## Verdict

**Status:** Request Changes (Conditional)

This codebase is well-structured with good patterns for webhook processing, graceful shutdown, and error monitoring. However, it has **8 blocking issues** that must be fixed before production deployment:

1. SQL injection in dynamic UPDATE
2. Timing attack on API key comparison
3. Unsafe JSON.parse() on untrusted input
4. Race condition in lead upsert
5. Insufficient URL validation (SSRF)
6. Missing phone validation
7. Path traversal in KB writes
8. SQL injection in job cancellation

After fixing these, the codebase is production-ready with the performance optimizations recommended for scale.

---

**Review completed:** March 2026
**Recommended deployment freeze until:** All CRITICAL issues resolved
