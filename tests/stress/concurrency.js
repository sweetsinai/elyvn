// tests/stress/concurrency.js
const BASE = 'http://localhost:3001';

async function post(path, body, contentType = 'application/json') {
  return fetch(`${BASE}${path}`, { method:'POST', headers:{'Content-Type':contentType}, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

async function run() {
  console.log('\n=== PHASE 2: CONCURRENCY ===\n');

  // 10 simultaneous call_ended events
  console.log('--- 10 simultaneous calls ---');
  const callResults = await Promise.all(Array.from({length:10}, (_,i) =>
    post('/webhooks/retell', {event:'call_ended',call:{call_id:`conc_${i}`,from_number:`+1555000${String(i).padStart(4,'0')}`,to_number:'+13612139099',duration:60+i*10}})
    .then(r=>({i,ok:r.status<500})).catch(e=>({i,ok:false,err:e.message}))
  ));
  const callFails = callResults.filter(r=>!r.ok);
  console.log(`  ${10-callFails.length}/10 OK${callFails.length ? ' | Failures: '+JSON.stringify(callFails) : ''}`);

  // 5 rapid calls from SAME number (dedup)
  console.log('\n--- 5 rapid calls same number ---');
  const dedupResults = await Promise.all(Array.from({length:5}, (_,i) =>
    post('/webhooks/retell', {event:'call_ended',call:{call_id:`dedup_${i}`,from_number:'+15559999999',to_number:'+13612139099',duration:30}})
    .then(r=>({i,ok:r.status<500})).catch(e=>({i,ok:false,err:e.message}))
  ));
  const dedupFails = dedupResults.filter(r=>!r.ok);
  console.log(`  ${5-dedupFails.length}/5 OK${dedupFails.length ? ' | Failures: '+JSON.stringify(dedupFails) : ''}`);

  // 15 rapid Telegram commands
  console.log('\n--- 15 rapid Telegram commands ---');
  const cmds = ['/stats','/calls','/leads','/today','/stats','/calls','/leads','/stats','/today','/calls','/leads','/stats','/calls','/today','/stats'];
  const TG_SECRET = 'elyvn-webhook-secret-2026';
  const tgResults = await Promise.all(cmds.map((cmd,i) =>
    fetch(`${BASE}/webhooks/telegram`, {method:'POST', headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':TG_SECRET}, body:JSON.stringify({message:{chat:{id:5919406237},from:{id:5919406237,first_name:'Test'},text:cmd}})})
    .then(r=>({cmd,ok:r.status<500})).catch(e=>({cmd,ok:false,err:e.message}))
  ));
  const tgFails = tgResults.filter(r=>!r.ok);
  console.log(`  ${15-tgFails.length}/15 OK${tgFails.length ? ' | Failures: '+JSON.stringify(tgFails) : ''}`);

  // Multi-channel simultaneously
  console.log('\n--- Multi-channel: call + SMS + telegram simultaneously ---');
  const multiResults = await Promise.all([
    post('/webhooks/retell', {event:'call_ended',call:{call_id:'multi_call',from_number:'+15558888888',to_number:'+13612139099',duration:90}}).then(r=>({ch:'retell',s:r.status})),
    post('/webhooks/twilio', 'From=%2B15558888888&To=%2B13612139099&Body=front+brakes+price&MessageSid=MULTI1', 'application/x-www-form-urlencoded').then(r=>({ch:'twilio',s:r.status})),
    fetch(`${BASE}/webhooks/telegram`, {method:'POST', headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':TG_SECRET}, body:JSON.stringify({message:{chat:{id:5919406237},from:{id:5919406237,first_name:'Test'},text:'/stats'}})}).then(r=>({ch:'telegram',s:r.status})),
  ]);
  multiResults.forEach(r => console.log(`  ${r.s<500?'OK':'FAIL'} ${r.ch}: ${r.s}`));

  console.log('\nConcurrency tests complete.');
}

run().catch(e => console.error('CONCURRENCY TEST CRASHED:', e));
