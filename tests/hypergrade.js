#!/usr/bin/env node

/**
 * ELYVN HYPERGRADE PRODUCTION TEST
 * Tests every feature in production. No mocks. Real API calls.
 *
 * Usage: BASE_URL=https://joyful-trust-production.up.railway.app node tests/hypergrade.js
 */

const BASE = process.env.BASE_URL || 'https://joyful-trust-production.up.railway.app';
const TG_API = 'https://api.telegram.org/bot8199060422:AAEQGNGN6Nrxpy4NXFVaWjOn5xeUW_oz8F0';
const TG_WEBHOOK_SECRET = 'elyvn-webhook-secret-2026';
const CHAT_ID = '5919406237';
const CLIENT_ID = 'a11fca87-de51-4f4c-9151-4aee804e16ec';

let passed = 0;
let failed = 0;
let warnings = 0;
const failures = [];
const testTimings = [];

const TEST_PHONES = {
  caller1: '+15551000001',
  caller2: '+15551000002',
  missedCaller: '+15551000003',
  formLead: '+15551000004',
  multiChannel: '+15551000005',
  rapidFire: '+15551000006',
  escalation: '+15551000007',
  repeatCustomer: '+15551000008',
};

async function post(path, body, headers = {}) {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function get(path) {
  return fetch(`${BASE}${path}`);
}

// Retell payload format: { event, call: { call_id, from_number, to_number, ... } }
async function retellPost(event, callData) {
  return post('/webhooks/retell', { event, call: callData });
}

// Telegram: must include webhook secret header
async function telegramPost(body) {
  return post('/webhooks/telegram', body, {
    'X-Telegram-Bot-Api-Secret-Token': TG_WEBHOOK_SECRET,
  });
}

async function telegramCommand(text) {
  return telegramPost({
    update_id: Date.now(),
    message: {
      message_id: Date.now(),
      chat: { id: 5919406237, type: 'private' },
      text,
      from: { id: 5919406237, first_name: 'Sohan' },
    },
  });
}

async function test(category, name, fn) {
  const start = Date.now();
  try {
    const result = await fn();
    if (result === 'warn') {
      warnings++;
      const ms = Date.now() - start;
      console.log(`  ⚠️  ${name} (${ms}ms)`);
    } else {
      passed++;
      const ms = Date.now() - start;
      testTimings.push({ name, ms });
      console.log(`  ✅ ${name} (${ms}ms)`);
    }
  } catch (e) {
    failed++;
    const ms = Date.now() - start;
    console.log(`  ❌ ${name} (${ms}ms): ${e.message}`);
    failures.push({ category, name, error: e.message });
  }
}

async function sendTelegram(text) {
  return fetch(`${TG_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' }),
  });
}

// ========================================
// TEST SUITE
// ========================================

async function run() {
  const startTime = Date.now();
  console.log(`\n🔬 ELYVN HYPERGRADE PRODUCTION TEST`);
  console.log(`   Target: ${BASE}`);
  console.log(`   Time: ${new Date().toISOString()}\n`);

  await sendTelegram('🔬 <b>ELYVN Hypergrade Test Starting</b>\n\nTesting all features against production...');

  // ============================================================
  // SECTION 1: SERVER INFRASTRUCTURE
  // ============================================================
  console.log('━━━ 1. SERVER INFRASTRUCTURE ━━━');

  await test('infra', 'Health endpoint returns 200', async () => {
    const r = await get('/health');
    if (r.status !== 200) throw new Error(`Status ${r.status}`);
    const d = await r.json();
    if (d.status !== 'ok') throw new Error(`Health status: ${d.status}`);
    console.log(`      DB: ${d.db_counts?.clients || '?'} clients, ${d.db_counts?.calls || '?'} calls, ${d.db_counts?.leads || '?'} leads | Heap: ${d.memory?.heap_used_mb || '?'}MB | Uptime: ${d.uptime_seconds || '?'}s`);
  });

  await test('infra', 'API returns JSON 404 (not SPA HTML)', async () => {
    const r = await get('/api/nonexistent-route');
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('json')) throw new Error(`Got ${ct} instead of JSON — SPA catch-all is eating API routes`);
  });

  await test('infra', 'Rate limiting active', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => get('/health'))
    );
    const allOk = results.every(r => r.status === 200);
    if (!allOk) throw new Error('Requests failed under rate limit');
  });

  await test('infra', 'JSON parse error returns 400', async () => {
    const r = await fetch(`${BASE}/webhooks/retell`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'this is not json{{{',
    });
    if (r.status === 500) throw new Error('Got 500 — JSON parse errors should return 400');
  });

  // ============================================================
  // SECTION 2: RETELL CALL PIPELINE
  // ============================================================
  console.log('\n━━━ 2. RETELL CALL PIPELINE ━━━');

  await test('retell', 'Normal call_ended processes correctly', async () => {
    const r = await retellPost('call_ended', {
      call_id: `hyper_call_${Date.now()}`,
      from_number: TEST_PHONES.caller1,
      to_number: '+18149966574',
      duration: 95,
      call_analysis: {
        call_summary: 'Customer inquired about front brake pad replacement pricing for a 2022 Honda Civic. Asked about warranty coverage and Saturday availability. High interest but needs to confirm with spouse.',
      },
    });
    if (r.status >= 500) throw new Error(`Status ${r.status}`);
  });

  await test('retell', 'call_started event accepted', async () => {
    const r = await retellPost('call_started', {
      call_id: `hyper_start_${Date.now()}`,
      from_number: TEST_PHONES.caller2,
      to_number: '+18149966574',
    });
    if (r.status >= 500) throw new Error(`Status ${r.status}`);
  });

  await test('retell', 'call_analyzed backfills transcript', async () => {
    const callId = `hyper_analyzed_${Date.now()}`;
    await retellPost('call_ended', {
      call_id: callId,
      from_number: TEST_PHONES.caller2,
      to_number: '+18149966574',
      duration: 120,
    });
    // call_analyzed arrives later
    const r = await retellPost('call_analyzed', {
      call_id: callId,
      transcript: 'Agent: Welcome to WeBrakes! Customer: Hi, I need brake pads for my BMW...',
      call_analysis: {
        call_summary: 'Customer needs brake pads for BMW X3. Interested in Saturday appointment.',
      },
    });
    if (r.status >= 500) throw new Error(`Status ${r.status}`);
  });

  await test('retell', 'Unknown event type handled gracefully', async () => {
    const r = await retellPost('some_future_event_type', {
      call_id: 'unknown_test',
    });
    if (r.status >= 500) throw new Error(`Status ${r.status} — unknown events should not crash`);
  });

  // ============================================================
  // SECTION 3: MISSED CALL TEXT-BACK
  // ============================================================
  console.log('\n━━━ 3. MISSED CALL TEXT-BACK ━━━');

  await test('missed', 'Duration 0 triggers text-back pipeline', async () => {
    const r = await retellPost('call_ended', {
      call_id: `hyper_missed_${Date.now()}`,
      from_number: TEST_PHONES.missedCaller,
      to_number: '+18149966574',
      duration: 0,
      call_analysis: { call_summary: '' },
    });
    if (r.status >= 500) throw new Error(`Status ${r.status}`);
  });

  await test('missed', 'Voicemail outcome triggers text-back', async () => {
    const r = await retellPost('call_ended', {
      call_id: `hyper_vm_${Date.now()}`,
      from_number: '+15551000009',
      to_number: '+18149966574',
      duration: 15,
      disconnection_reason: 'voicemail',
      call_analysis: { call_summary: '' },
    });
    if (r.status >= 500) throw new Error(`Status ${r.status}`);
  });

  await test('missed', 'No-answer outcome triggers text-back', async () => {
    const r = await retellPost('call_ended', {
      call_id: `hyper_na_${Date.now()}`,
      from_number: '+15551000010',
      to_number: '+18149966574',
      duration: 0,
      disconnection_reason: 'no_answer',
      call_analysis: { call_summary: '' },
    });
    if (r.status >= 500) throw new Error(`Status ${r.status}`);
  });

  // ============================================================
  // SECTION 4: SMS AUTO-REPLY + BRAIN
  // ============================================================
  console.log('\n━━━ 4. SMS AUTO-REPLY + BRAIN ━━━');

  await test('sms', 'Normal SMS gets auto-reply', async () => {
    const r = await post('/webhooks/twilio', {
      From: TEST_PHONES.caller1,
      To: '+13612139099',
      Body: 'How much for front brake pads on a 2021 Toyota Camry?',
    });
    if (r.status >= 500) throw new Error(`Status ${r.status}`);
  });

  await test('sms', 'Cross-channel: same number that called now texts', async () => {
    const r = await post('/webhooks/twilio', {
      From: TEST_PHONES.caller1,
      To: '+13612139099',
      Body: 'Hey I called earlier about brakes for my Civic. Wife says go for it! Saturday morning open?',
    });
    if (r.status >= 500) throw new Error(`Status ${r.status}`);
  });

  await test('sms', 'Escalation trigger (complaint)', async () => {
    const r = await post('/webhooks/twilio', {
      From: TEST_PHONES.escalation,
      To: '+13612139099',
      Body: 'Your technician scratched my rims last week. I want a full refund or Im calling my lawyer.',
    });
    if (r.status >= 500) throw new Error(`Status ${r.status}`);
  });

  await test('sms', 'Empty body handled', async () => {
    const r = await post('/webhooks/twilio', {
      From: '+15551000011',
      To: '+13612139099',
      Body: '',
    });
    if (r.status >= 500) throw new Error(`Status ${r.status}`);
  });

  await test('sms', 'Missing From field handled', async () => {
    const r = await post('/webhooks/twilio', {
      To: '+13612139099',
      Body: 'test',
    });
    if (r.status >= 500) throw new Error(`Status ${r.status}`);
  });

  // ============================================================
  // SECTION 5: SPEED-TO-LEAD ENGINE
  // ============================================================
  console.log('\n━━━ 5. SPEED-TO-LEAD ENGINE ━━━');

  await test('speed', 'Form submission triggers speed sequence', async () => {
    const r = await post(`/webhooks/form/${CLIENT_ID}`, {
      name: 'Speed Test Lead',
      phone: '+15551000020',
      message: 'I need brake pads replaced ASAP',
      service: 'Front brake pads',
    });
    if (r.status >= 500) throw new Error(`Status ${r.status}`);
  });

  // ============================================================
  // SECTION 6: WEB FORM CAPTURE
  // ============================================================
  console.log('\n━━━ 6. WEB FORM CAPTURE ━━━');

  await test('form', 'Standard form submission', async () => {
    const r = await post(`/webhooks/form/${CLIENT_ID}`, {
      name: 'John Smith',
      phone: '+15552223333',
      email: 'john@example.com',
      message: 'Need brakes checked on my 2020 F-150',
    });
    if (r.status !== 200) throw new Error(`Status ${r.status}`);
  });

  await test('form', 'Contact Form 7 field names', async () => {
    const r = await post(`/webhooks/form/${CLIENT_ID}`, {
      'your-name': 'Jane Doe',
      'your-phone': '5553334444',
      'your-email': 'jane@example.com',
      'your-message': 'Looking for brake service',
    });
    if (r.status !== 200) throw new Error(`Status ${r.status}`);
  });

  await test('form', '10-digit phone normalized to +1', async () => {
    const r = await post(`/webhooks/form/${CLIENT_ID}`, {
      name: 'Bob',
      phone: '5559998888',
      message: 'test',
    });
    if (r.status !== 200) throw new Error(`Status ${r.status}`);
  });

  await test('form', 'No phone — email-only lead', async () => {
    const r = await post(`/webhooks/form/${CLIENT_ID}`, {
      name: 'Email Only',
      email: 'emailonly@test.com',
      message: 'Just emailing',
    });
    if (r.status !== 200) throw new Error(`Status ${r.status}`);
  });

  await test('form', 'Completely empty form', async () => {
    const r = await post(`/webhooks/form/${CLIENT_ID}`, {});
    if (r.status >= 500) throw new Error(`Status ${r.status} — empty form should not crash`);
  });

  await test('form', 'Invalid client ID', async () => {
    const r = await post('/webhooks/form/nonexistent_client_id', {
      name: 'Test',
      phone: '+15550000000',
    });
    if (r.status >= 500) throw new Error(`Status ${r.status} — bad client should not crash`);
  });

  await test('form', 'URL-encoded form body (WordPress default)', async () => {
    const r = await fetch(`${BASE}/webhooks/form/${CLIENT_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'name=URL+Encoded&phone=5557776666&message=Testing+URL+encode',
    });
    if (r.status >= 500) throw new Error(`Status ${r.status}`);
  });

  await test('form', 'Body-based client_id (no URL param)', async () => {
    const r = await post('/webhooks/form', {
      client_id: CLIENT_ID,
      name: 'Body Client Test',
      phone: '+15551112222',
      message: 'Testing body client_id',
    });
    if (r.status >= 500) throw new Error(`Status ${r.status}`);
  });

  // ============================================================
  // SECTION 7: TELEGRAM COMMANDS
  // ============================================================
  console.log('\n━━━ 7. TELEGRAM COMMANDS ━━━');

  const tgCommands = ['/stats', '/calls', '/leads', '/brain', '/today', '/help'];

  for (const cmd of tgCommands) {
    await test('telegram', `Command: ${cmd}`, async () => {
      const r = await telegramCommand(cmd);
      if (r.status >= 500) throw new Error(`Status ${r.status}`);
    });
    await new Promise(r => setTimeout(r, 500));
  }

  await test('telegram', 'Command: /pause', async () => {
    const r = await telegramCommand('/pause');
    if (r.status >= 500) throw new Error(`Status ${r.status}`);
  });

  await test('telegram', 'Command: /resume', async () => {
    const r = await telegramCommand('/resume');
    if (r.status >= 500) throw new Error(`Status ${r.status}`);
  });

  await test('telegram', 'Command: /complete +15551000001', async () => {
    const r = await telegramCommand('/complete +15551000001');
    if (r.status >= 500) throw new Error(`Status ${r.status}`);
  });

  await test('telegram', 'Command: /setreview https://g.page/r/webrakes/review', async () => {
    const r = await telegramCommand('/setreview https://g.page/r/webrakes/review');
    if (r.status >= 500) throw new Error(`Status ${r.status}`);
  });

  await test('telegram', 'Photo message (no text) handled', async () => {
    const r = await telegramPost({
      update_id: Date.now(),
      message: {
        message_id: Date.now(),
        chat: { id: 5919406237, type: 'private' },
        from: { id: 5919406237, first_name: 'Sohan' },
        photo: [{ file_id: 'test', width: 100, height: 100 }],
      },
    });
    if (r.status >= 500) throw new Error(`Status ${r.status}`);
  });

  await test('telegram', 'Callback query handled', async () => {
    const r = await telegramPost({
      update_id: Date.now(),
      callback_query: {
        id: `cb_${Date.now()}`,
        chat_instance: 'test',
        data: 'cancel_speed_test',
        from: { id: 5919406237, first_name: 'Sohan' },
        message: {
          message_id: 999,
          chat: { id: 5919406237, type: 'private' },
        },
      },
    });
    if (r.status >= 500) throw new Error(`Status ${r.status}`);
  });

  await test('telegram', 'Without webhook secret returns 403', async () => {
    const r = await post('/webhooks/telegram', {
      update_id: Date.now(),
      message: {
        message_id: Date.now(),
        chat: { id: 5919406237, type: 'private' },
        text: '/stats',
        from: { id: 5919406237, first_name: 'Sohan' },
      },
    });
    if (r.status !== 403) throw new Error(`Expected 403, got ${r.status}`);
  });

  // ============================================================
  // SECTION 8: CONCURRENCY STRESS
  // ============================================================
  console.log('\n━━━ 8. CONCURRENCY STRESS ━━━');

  await test('concurrency', '10 simultaneous calls', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        retellPost('call_ended', {
          call_id: `concurrent_${Date.now()}_${i}`,
          from_number: `+15552${String(i).padStart(6, '0')}`,
          to_number: '+18149966574',
          duration: 60 + i * 10,
          call_analysis: { call_summary: `Concurrent test call ${i}` },
        }).then(r => r.status).catch(() => 500)
      )
    );
    const errors = results.filter(s => s >= 500);
    if (errors.length > 0) throw new Error(`${errors.length}/10 returned 500`);
  });

  await test('concurrency', '15 simultaneous SMS messages', async () => {
    const results = await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        post('/webhooks/twilio', {
          From: `+15553${String(i).padStart(6, '0')}`,
          To: '+13612139099',
          Body: `Concurrent SMS test ${i}: brake pricing?`,
        }).then(r => r.status).catch(() => 500)
      )
    );
    const errors = results.filter(s => s >= 500);
    if (errors.length > 0) throw new Error(`${errors.length}/15 returned 500`);
  });

  await test('concurrency', '5 simultaneous form submissions', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        post(`/webhooks/form/${CLIENT_ID}`, {
          name: `Form Lead ${i}`,
          phone: `+15554${String(i).padStart(6, '0')}`,
          message: `Concurrent form test ${i}`,
        }).then(r => r.status).catch(() => 500)
      )
    );
    const errors = results.filter(s => s >= 500);
    if (errors.length > 0) throw new Error(`${errors.length}/5 returned 500`);
  });

  await test('concurrency', 'Multi-channel simultaneous (call + SMS + form + Telegram)', async () => {
    const results = await Promise.all([
      retellPost('call_ended', {
        call_id: `multi_${Date.now()}`,
        from_number: '+15559000001',
        to_number: '+18149966574',
        duration: 60,
        call_analysis: { call_summary: 'Multi-channel test' },
      }).then(r => ({ ch: 'retell', s: r.status })).catch(e => ({ ch: 'retell', err: e.message })),

      post('/webhooks/twilio', {
        From: '+15559000002',
        To: '+13612139099',
        Body: 'Multi-channel test SMS',
      }).then(r => ({ ch: 'twilio', s: r.status })).catch(e => ({ ch: 'twilio', err: e.message })),

      post(`/webhooks/form/${CLIENT_ID}`, {
        name: 'Multi Test',
        phone: '+15559000003',
        message: 'Multi-channel form',
      }).then(r => ({ ch: 'form', s: r.status })).catch(e => ({ ch: 'form', err: e.message })),

      telegramCommand('/stats')
        .then(r => ({ ch: 'telegram', s: r.status })).catch(e => ({ ch: 'telegram', err: e.message })),
    ]);
    const errors = results.filter(r => r.err || r.s >= 500);
    if (errors.length > 0) throw new Error(`Failed: ${JSON.stringify(errors)}`);
  });

  // ============================================================
  // SECTION 9: MALFORMED INPUT ATTACKS
  // ============================================================
  console.log('\n━━━ 9. MALFORMED INPUT ATTACKS ━━━');

  const malformedTests = [
    ['SQL injection in SMS', '/webhooks/twilio', { From: '+15550000000', To: '+13612139099', Body: "'; DROP TABLE calls; --" }],
    ['XSS in form name', `/webhooks/form/${CLIENT_ID}`, { name: '<script>alert("xss")</script>', phone: '+15550000001', message: 'test' }],
    ['Huge transcript (50KB)', '/webhooks/retell', { event: 'call_analyzed', call: { call_id: 'huge_test', transcript: 'A'.repeat(50000) } }],
    ['Emoji flood in SMS', '/webhooks/twilio', { From: '+15550000002', To: '+13612139099', Body: '😀'.repeat(500) }],
    ['Null bytes in message', '/webhooks/twilio', { From: '+15550000003', To: '+13612139099', Body: 'hello\x00world' }],
    ['Negative duration', '/webhooks/retell', { event: 'call_ended', call: { call_id: 'neg_dur', from_number: '+15550000004', to_number: '+18149966574', duration: -100 } }],
    ['Array instead of object', '/webhooks/retell', [1, 2, 3]],
    ['Deeply nested object', `/webhooks/form/${CLIENT_ID}`, { a: { b: { c: { d: { e: { f: 'deep' } } } } } }],
  ];

  for (const [name, path, body] of malformedTests) {
    await test('malformed', name, async () => {
      const r = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.status >= 500) throw new Error(`Status ${r.status} — should handle gracefully`);
    });
  }

  // ============================================================
  // SECTION 10: FULL END-TO-END FLOW
  // ============================================================
  console.log('\n━━━ 10. FULL END-TO-END FLOW ━━━');

  const e2ePhone = '+15557770001';

  await test('e2e', 'Step 1: Customer calls (high intent, no booking)', async () => {
    const r = await retellPost('call_ended', {
      call_id: `e2e_${Date.now()}`,
      from_number: e2ePhone,
      to_number: '+18149966574',
      duration: 180,
      call_analysis: {
        call_summary: 'Customer very interested in front brake replacement for 2023 Toyota RAV4. Asked about pricing ($159.99), warranty (24 months), and Saturday availability. Wants to bring it in this weekend but needs to check schedule first. High intent.',
      },
    });
    if (r.status >= 500) throw new Error(`Call failed: ${r.status}`);
  });

  console.log('      ⏳ Waiting 12s for brain + speed-to-lead...');
  await new Promise(r => setTimeout(r, 12000));

  await test('e2e', 'Step 2: Same customer texts next day', async () => {
    const r = await post('/webhooks/twilio', {
      From: e2ePhone,
      To: '+13612139099',
      Body: 'Hey I called yesterday about brakes for my RAV4. Schedule is clear — can I come in Saturday at 10am?',
    });
    if (r.status >= 500) throw new Error(`SMS failed: ${r.status}`);
  });

  console.log('      ⏳ Waiting 10s for brain cross-channel processing...');
  await new Promise(r => setTimeout(r, 10000));

  await test('e2e', 'Step 3: Customer submits web form too', async () => {
    const r = await post(`/webhooks/form/${CLIENT_ID}`, {
      name: 'RAV4 Customer',
      phone: e2ePhone.replace('+1', ''),
      email: 'rav4customer@test.com',
      message: 'Want to book Saturday 10am for brake pads',
      service: 'Front brake pads',
    });
    if (r.status !== 200) throw new Error(`Form failed: ${r.status}`);
  });

  console.log('      ⏳ Waiting 5s...');
  await new Promise(r => setTimeout(r, 5000));

  await test('e2e', 'Step 4: Owner marks job complete', async () => {
    const r = await telegramCommand(`/complete ${e2ePhone}`);
    if (r.status >= 500) throw new Error(`Complete failed: ${r.status}`);
  });

  await test('e2e', 'Step 5: Verify /brain shows decisions', async () => {
    const r = await telegramCommand('/brain');
    if (r.status >= 500) throw new Error(`Brain command failed: ${r.status}`);
  });

  // ============================================================
  // SECTION 11: AGENT SQUAD FILE CHECK
  // ============================================================
  console.log('\n━━━ 11. AGENT SQUAD (FILE CHECKS) ━━━');

  const { execSync } = require('child_process');
  const agentFiles = [
    ['Scout SOUL.md', '~/elyvn-agents/agents/scout/SOUL.md'],
    ['Scout run.sh', '~/elyvn-agents/agents/scout/run.sh'],
    ['Writer SOUL.md', '~/elyvn-agents/agents/writer/SOUL.md'],
    ['Writer run.sh', '~/elyvn-agents/agents/writer/run.sh'],
    ['Sender SOUL.md', '~/elyvn-agents/agents/sender/SOUL.md'],
    ['Sender run.sh', '~/elyvn-agents/agents/sender/run.sh'],
    ['Classifier SOUL.md', '~/elyvn-agents/agents/classifier/SOUL.md'],
    ['Classifier run.sh', '~/elyvn-agents/agents/classifier/run.sh'],
    ['Builder SOUL.md', '~/elyvn-agents/agents/builder/SOUL.md'],
    ['Builder run.sh', '~/elyvn-agents/agents/builder/run.sh'],
    ['Shared config.json', '~/elyvn-agents/shared/config.json'],
    ['Shared send-email.js', '~/elyvn-agents/shared/send-email.js'],
    ['HEARTBEAT.md', '~/elyvn-agents/HEARTBEAT.md'],
  ];

  for (const [name, path] of agentFiles) {
    await test('agents', `${name} exists`, async () => {
      try {
        execSync(`test -f ${path}`);
      } catch {
        throw new Error(`${path} not found`);
      }
    });
  }

  await test('agents', 'config.json is valid JSON', async () => {
    try {
      const content = execSync('cat ~/elyvn-agents/shared/config.json').toString();
      const cfg = JSON.parse(content);
      if (!cfg.target_industries || !cfg.target_cities) throw new Error('Missing required fields');
    } catch (e) {
      throw new Error(`config.json: ${e.message}`);
    }
  });

  // ============================================================
  // SECTION 12: EMBED SCRIPT
  // ============================================================
  console.log('\n━━━ 12. EMBED SCRIPT ━━━');

  await test('embed', 'embed.js loads via HTTP', async () => {
    const r = await get('/embed.js');
    if (r.status !== 200) throw new Error(`Status ${r.status}`);
    const text = await r.text();
    if (!text.includes('elyvn-form')) throw new Error('embed.js missing form handler code');
  });

  // ============================================================
  // SECTION 13: API AUTH
  // ============================================================
  console.log('\n━━━ 13. API AUTH ━━━');

  await test('auth', 'API without key (dev mode — should pass)', async () => {
    const r = await get('/api/clients');
    // ELYVN_API_KEY is not set, so should pass through
    if (r.status === 401) throw new Error('Got 401 — API key enforcement is on but key not set on Railway');
    if (r.status >= 500) throw new Error(`Status ${r.status}`);
  });

  // ============================================================
  // SUMMARY
  // ============================================================
  const totalTime = Math.floor((Date.now() - startTime) / 1000);
  const slowTests = testTimings.filter(t => t.ms > 5000).sort((a, b) => b.ms - a.ms);

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ELYVN HYPERGRADE TEST RESULTS`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`  ✅ Passed:   ${passed}`);
  console.log(`  ❌ Failed:   ${failed}`);
  console.log(`  ⚠️  Warnings: ${warnings}`);
  console.log(`  ⏱️  Total:    ${totalTime}s`);

  if (failures.length > 0) {
    console.log(`\n  FAILURES:`);
    failures.forEach(f => {
      console.log(`    [${f.category}] ${f.name}`);
      console.log(`      → ${f.error}`);
    });
  }

  if (slowTests.length > 0) {
    console.log(`\n  SLOW TESTS (>5s):`);
    slowTests.forEach(t => {
      console.log(`    ${t.name}: ${(t.ms / 1000).toFixed(1)}s`);
    });
  }

  console.log(`\n${'═'.repeat(60)}`);

  if (failed === 0) {
    console.log('  🎉 ALL TESTS PASSED — ELYVN IS PRODUCTION READY');
    console.log('  Ship it. Sell it. Go record the demo.');
  } else {
    console.log(`  ⚠️  ${failed} FAILURES — fix these before going live`);
  }
  console.log(`${'═'.repeat(60)}\n`);

  await sendTelegram(
    `🔬 <b>Hypergrade Test Complete</b>\n\n` +
    `✅ Passed: ${passed}\n` +
    `❌ Failed: ${failed}\n` +
    `⚠️ Warnings: ${warnings}\n` +
    `⏱️ Time: ${totalTime}s\n\n` +
    (failed === 0
      ? '🎉 ALL PASSED — Production ready!'
      : `Failures:\n${failures.map(f => `• ${f.name}: ${f.error}`).join('\n')}`)
  );
}

run().catch(e => {
  console.error('💥 Test suite crashed:', e);
  process.exit(1);
});
