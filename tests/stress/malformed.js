// tests/stress/malformed.js
const BASE = 'http://localhost:3001';
let passed = 0, failed = 0;
const failures = [];

async function test(name, fn) {
  try { await fn(); passed++; console.log(`  PASS ${name}`); }
  catch(e) { failed++; console.log(`  FAIL ${name}: ${e.message}`); failures.push({name, error: e.message}); }
}

async function run() {
  console.log('\n=== PHASE 1: MALFORMED PAYLOADS ===\n');

  // RETELL
  console.log('--- Retell ---');
  await test('Empty body', async () => {
    const r = await fetch(`${BASE}/webhooks/retell`, { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
    if (r.status >= 500) throw new Error(`500: ${r.status}`);
  });
  await test('Missing event', async () => {
    const r = await fetch(`${BASE}/webhooks/retell`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({call:{call_id:'x'}}) });
    if (r.status >= 500) throw new Error(`500: ${r.status}`);
  });
  await test('Null call_id in call_ended', async () => {
    const r = await fetch(`${BASE}/webhooks/retell`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({event:'call_ended',call:{call_id:null}}) });
    if (r.status >= 500) throw new Error(`500: ${r.status}`);
  });
  await test('Negative duration', async () => {
    const r = await fetch(`${BASE}/webhooks/retell`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({event:'call_ended',call:{call_id:'neg_dur',from_number:'+10000000000',to_number:'+13612139099',duration:-500}}) });
    if (r.status >= 500) throw new Error(`500: ${r.status}`);
  });
  await test('No phone numbers', async () => {
    const r = await fetch(`${BASE}/webhooks/retell`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({event:'call_ended',call:{call_id:'no_phones',duration:60}}) });
    if (r.status >= 500) throw new Error(`500: ${r.status}`);
  });
  await test('Malformed phone', async () => {
    const r = await fetch(`${BASE}/webhooks/retell`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({event:'call_ended',call:{call_id:'bad_phone',from_number:'+abc',to_number:'not_a_number',duration:30}}) });
    if (r.status >= 500) throw new Error(`500: ${r.status}`);
  });
  await test('Non-JSON body', async () => {
    const r = await fetch(`${BASE}/webhooks/retell`, { method:'POST', headers:{'Content-Type':'application/json'}, body:'this is not json' });
    if (r.status >= 500) throw new Error(`500: ${r.status}`);
  });
  await test('Array body', async () => {
    const r = await fetch(`${BASE}/webhooks/retell`, { method:'POST', headers:{'Content-Type':'application/json'}, body:'[1,2,3]' });
    if (r.status >= 500) throw new Error(`500: ${r.status}`);
  });
  await test('50KB transcript', async () => {
    const r = await fetch(`${BASE}/webhooks/retell`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({event:'call_analyzed',call:{call_id:'huge',call_analysis:{call_summary:'A'.repeat(50000)}}}) });
    if (r.status >= 500) throw new Error(`500: ${r.status}`);
  });
  await test('call_started with undefined call', async () => {
    const r = await fetch(`${BASE}/webhooks/retell`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({event:'call_started'}) });
    if (r.status >= 500) throw new Error(`500: ${r.status}`);
  });
  await test('transfer_requested with no call', async () => {
    const r = await fetch(`${BASE}/webhooks/retell`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({event:'transfer_requested'}) });
    if (r.status >= 500) throw new Error(`500: ${r.status}`);
  });
  await test('dtmf with no call', async () => {
    const r = await fetch(`${BASE}/webhooks/retell`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({event:'dtmf'}) });
    if (r.status >= 500) throw new Error(`500: ${r.status}`);
  });

  // TWILIO
  console.log('\n--- Twilio ---');
  await test('Empty SMS body', async () => {
    const r = await fetch(`${BASE}/webhooks/twilio`, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:'From=%2B10000000000&To=%2B13612139099&Body=' });
    if (r.status >= 500) throw new Error(`500`);
  });
  await test('Missing From', async () => {
    const r = await fetch(`${BASE}/webhooks/twilio`, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:'To=%2B13612139099&Body=hello' });
    if (r.status >= 500) throw new Error(`500`);
  });
  await test('Missing To', async () => {
    const r = await fetch(`${BASE}/webhooks/twilio`, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:'From=%2B10000000000&Body=hello' });
    if (r.status >= 500) throw new Error(`500`);
  });
  await test('SQL injection in body', async () => {
    const r = await fetch(`${BASE}/webhooks/twilio`, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:"From=%2B10000000000&To=%2B13612139099&Body='+DROP+TABLE+calls;+--" });
    if (r.status >= 500) throw new Error(`500`);
  });
  await test('XSS in body', async () => {
    const r = await fetch(`${BASE}/webhooks/twilio`, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:'From=%2B10000000000&To=%2B13612139099&Body=%3Cscript%3Ealert(1)%3C/script%3E' });
    if (r.status >= 500) throw new Error(`500`);
  });
  await test('10KB body', async () => {
    const r = await fetch(`${BASE}/webhooks/twilio`, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:'From=%2B10000000000&To=%2B13612139099&Body=' + 'X'.repeat(10000) });
    if (r.status >= 500) throw new Error(`500`);
  });

  // TELEGRAM
  console.log('\n--- Telegram ---');
  const TG_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || 'elyvn-webhook-secret-2026';
  const tgHeaders = {'Content-Type':'application/json', 'X-Telegram-Bot-Api-Secret-Token': TG_SECRET};

  await test('Empty update', async () => {
    const r = await fetch(`${BASE}/webhooks/telegram`, { method:'POST', headers: tgHeaders, body:'{}' });
    if (r.status >= 500) throw new Error(`500`);
  });
  await test('Unknown command', async () => {
    const r = await fetch(`${BASE}/webhooks/telegram`, { method:'POST', headers: tgHeaders, body: JSON.stringify({message:{chat:{id:5919406237},from:{id:5919406237,first_name:'Test'},text:'/nonexistent'}}) });
    if (r.status >= 500) throw new Error(`500`);
  });
  await test('Photo message (no text)', async () => {
    const r = await fetch(`${BASE}/webhooks/telegram`, { method:'POST', headers: tgHeaders, body: JSON.stringify({message:{chat:{id:5919406237},from:{id:5919406237,first_name:'Test'},photo:[{file_id:'x'}]}}) });
    if (r.status >= 500) throw new Error(`500`);
  });
  await test('Invalid callback data', async () => {
    const r = await fetch(`${BASE}/webhooks/telegram`, { method:'POST', headers: tgHeaders, body: JSON.stringify({callback_query:{id:'cb1',from:{id:5919406237},message:{chat:{id:5919406237}},data:'garbage:data:here'}}) });
    if (r.status >= 500) throw new Error(`500`);
  });
  await test('Wrong webhook secret', async () => {
    const r = await fetch(`${BASE}/webhooks/telegram`, { method:'POST', headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':'wrong'}, body:'{}' });
    if (r.status !== 403) throw new Error(`Expected 403, got ${r.status}`);
  });

  // FORM
  console.log('\n--- Form ---');
  await test('Invalid client ID', async () => {
    const r = await fetch(`${BASE}/webhooks/form/nonexistent_client`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name:'test',phone:'+15551234567'}) });
    if (r.status >= 500) throw new Error(`500`);
  });
  await test('Empty form body', async () => {
    const r = await fetch(`${BASE}/webhooks/form/webrakes`, { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
    if (r.status >= 500) throw new Error(`500`);
  });

  // API
  console.log('\n--- API ---');
  await test('Health check', async () => {
    const r = await fetch(`${BASE}/health`);
    if (r.status !== 200) throw new Error(`${r.status}`);
  });
  await test('Invalid client_id in API calls', async () => {
    const r = await fetch(`${BASE}/api/calls/nonexistent`);
    if (r.status >= 500) throw new Error(`500`);
  });
  await test('SQL injection in leads query', async () => {
    const r = await fetch(`${BASE}/api/leads/test'; DROP TABLE leads;--`);
    if (r.status >= 500) throw new Error(`500`);
  });
  await test('Extreme pagination', async () => {
    const r = await fetch(`${BASE}/api/calls/test?page=999999&limit=999999`);
    if (r.status >= 500) throw new Error(`500`);
  });
  await test('NaN pagination', async () => {
    const r = await fetch(`${BASE}/api/calls/test?page=abc&limit=xyz`);
    if (r.status >= 500) throw new Error(`500`);
  });
  await test('Negative pagination', async () => {
    const r = await fetch(`${BASE}/api/calls/test?page=-1&limit=-5`);
    if (r.status >= 500) throw new Error(`500`);
  });

  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  if (failures.length) { console.log('Failures:'); failures.forEach(f => console.log(`  - ${f.name}: ${f.error}`)); }
}

run().catch(e => console.error('TEST RUNNER CRASHED:', e));
