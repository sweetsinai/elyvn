// tests/stress/db_integrity.js
const path = require('path');
// Resolve better-sqlite3 from the bridge's node_modules
const modulePath = path.join(__dirname, '../../server/bridge/node_modules');
module.paths.unshift(modulePath);
const DB_PATH = path.join(__dirname, '../../server/mcp/elyvn.db');

function run() {
  console.log('\n=== PHASE 3: DB INTEGRITY ===\n');
  let db;
  try { db = require('better-sqlite3')(DB_PATH, {readonly:true}); }
  catch(e) { console.log('Cannot open DB:', e.message); return; }

  const integrity = db.pragma('integrity_check');
  console.log(`${integrity[0].integrity_check==='ok'?'OK':'FAIL'} Integrity: ${integrity[0].integrity_check}`);

  const journal = db.pragma('journal_mode');
  console.log(`${journal[0].journal_mode==='wal'?'OK':'WARN'} Journal: ${journal[0].journal_mode}`);

  console.log('\n--- Row counts ---');
  ['clients','calls','messages','leads','followups','prospects','campaigns','campaign_prospects','emails_sent','weekly_reports'].forEach(t => {
    try { const c = db.prepare('SELECT COUNT(*) as c FROM '+t).get(); console.log(`  ${t}: ${c.c}`); }
    catch(e) { console.log(`  MISSING ${t}: ${e.message}`); }
  });

  console.log('\n--- Orphans ---');
  try { const o = db.prepare('SELECT COUNT(*) as c FROM calls WHERE client_id IS NOT NULL AND client_id NOT IN (SELECT id FROM clients)').get(); console.log(`  ${o.c===0?'OK':'FAIL'} Orphan calls: ${o.c}`); } catch(e) { console.log('  WARN',e.message); }
  try { const o = db.prepare('SELECT COUNT(*) as c FROM leads WHERE client_id NOT IN (SELECT id FROM clients)').get(); console.log(`  ${o.c===0?'OK':'FAIL'} Orphan leads: ${o.c}`); } catch(e) { console.log('  WARN',e.message); }
  try { const o = db.prepare('SELECT COUNT(*) as c FROM followups WHERE lead_id NOT IN (SELECT id FROM leads)').get(); console.log(`  ${o.c===0?'OK':'FAIL'} Orphan followups: ${o.c}`); } catch(e) { console.log('  WARN',e.message); }

  console.log('\n--- NULLs in required fields ---');
  [['calls','call_id'],['leads','client_id'],['leads','phone'],['messages','client_id']].forEach(([t,c]) => {
    try { const n = db.prepare(`SELECT COUNT(*) as c FROM ${t} WHERE ${c} IS NULL`).get(); console.log(`  ${n.c===0?'OK':'FAIL'} ${t}.${c} NULLs: ${n.c}`); } catch(e) { console.log('  WARN',e.message); }
  });

  db.close();
}

run();
