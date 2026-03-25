const Database = require('better-sqlite3');
const { getLeadMemory } = require('../utils/leadMemory');
const { runMigrations } = require('../utils/migrations');

describe('getLeadMemory', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);

    // Insert test client
    db.prepare(`
      INSERT INTO clients (id, name, owner_name)
      VALUES ('client1', 'Test Business', 'John Owner')
    `).run();
  });

  afterEach(() => {
    db.close();
  });

  it('should create new lead if none exists', () => {
    const memory = getLeadMemory(db, '2125551234', 'client1');

    expect(memory).toBeDefined();
    expect(memory.lead).toBeDefined();
    expect(memory.lead.phone).toBe('+12125551234');
    expect(memory.lead.client_id).toBe('client1');
    expect(memory.lead.stage).toBe('new');
    expect(memory.lead.score).toBe(0);
  });

  it('should return existing lead if one exists', () => {
    // Create lead manually
    db.prepare(`
      INSERT INTO leads (id, client_id, phone, score, stage, name)
      VALUES ('lead1', 'client1', '+12125551234', 7, 'warm', 'John Doe')
    `).run();

    const memory = getLeadMemory(db, '2125551234', 'client1');

    expect(memory.lead.id).toBe('lead1');
    expect(memory.lead.name).toBe('John Doe');
    expect(memory.lead.score).toBe(7);
    expect(memory.lead.stage).toBe('warm');
  });

  it('should normalize phone number', () => {
    const memory = getLeadMemory(db, '(212) 555-1234', 'client1');
    expect(memory.lead.phone).toBe('+12125551234');
  });

  it('should return null if phone is invalid', () => {
    const memory = getLeadMemory(db, 'invalid', 'client1');
    expect(memory).toBeNull();
  });

  it('should return null if clientId is missing', () => {
    const memory = getLeadMemory(db, '2125551234', null);
    expect(memory).toBeNull();
  });

  it('should fetch all calls for lead', () => {
    db.prepare(`
      INSERT INTO leads (id, client_id, phone, score, stage)
      VALUES ('lead1', 'client1', '+12125551234', 5, 'new')
    `).run();

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, summary, outcome, score, created_at)
      VALUES
        ('call1', 'call1_id', 'client1', '+12125551234', 'inbound', 300, 'Good call', 'qualified', 8, ?),
        ('call2', 'call2_id', 'client1', '+12125551234', 'inbound', 120, 'Short call', 'not_interested', 3, ?)
    `).run(now, now);

    const memory = getLeadMemory(db, '2125551234', 'client1');

    expect(memory.calls).toHaveLength(2);
    expect(memory.calls[0].id).toBe('call2');
  });

  it('should fetch all messages for lead', () => {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO messages (id, client_id, phone, direction, body, status, created_at)
      VALUES
        ('msg1', 'client1', '+12125551234', 'inbound', 'Hi there', 'received', ?),
        ('msg2', 'client1', '+12125551234', 'outbound', 'Hello back', 'sent', ?)
    `).run(now, now);

    const memory = getLeadMemory(db, '2125551234', 'client1');

    expect(memory.messages).toHaveLength(2);
    expect(memory.messages[0].body).toBe('Hello back');
  });

  it('should fetch all followups for lead', () => {
    db.prepare(`
      INSERT INTO leads (id, client_id, phone, score, stage)
      VALUES ('lead1', 'client1', '+12125551234', 5, 'new')
    `).run();

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, scheduled_at, status, created_at)
      VALUES
        ('fu1', 'lead1', 'client1', 1, 'sms', 'First touch', ?, 'scheduled', ?),
        ('fu2', 'lead1', 'client1', 2, 'sms', 'Second touch', ?, 'scheduled', ?)
    `).run(now, now, now, now);

    const memory = getLeadMemory(db, '2125551234', 'client1');

    expect(memory.followups).toHaveLength(2);
    expect(memory.followups[0].touch_number).toBe(1);
  });

  it('should build chronological timeline', () => {
    db.prepare(`
      INSERT INTO leads (id, client_id, phone, score, stage)
      VALUES ('lead1', 'client1', '+12125551234', 5, 'new')
    `).run();

    const t1 = new Date('2024-01-01T10:00:00Z').toISOString();
    const t2 = new Date('2024-01-01T11:00:00Z').toISOString();
    const t3 = new Date('2024-01-01T12:00:00Z').toISOString();

    // Insert in reverse order to test sorting
    db.prepare(`
      INSERT INTO messages (id, client_id, phone, direction, body, status, created_at)
      VALUES ('msg1', 'client1', '+12125551234', 'inbound', 'Message', 'received', ?)
    `).run(t3);

    db.prepare(`
      INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, summary, outcome, score, created_at)
      VALUES ('call1', 'call1', 'client1', '+12125551234', 'inbound', 300, 'Call', 'qualified', 8, ?)
    `).run(t1);

    db.prepare(`
      INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, scheduled_at, sent_at, status, created_at)
      VALUES ('fu1', 'lead1', 'client1', 1, 'sms', 'Followup', ?, ?, 'sent', ?)
    `).run(t2, t2, t2);

    const memory = getLeadMemory(db, '2125551234', 'client1');

    expect(memory.timeline).toHaveLength(3);
    expect(memory.timeline[0].type).toBe('call');
    expect(memory.timeline[1].type).toBe('followup_sent');
    expect(memory.timeline[2].type).toBe('message');
  });

  it('should calculate insights correctly', () => {
    db.prepare(`
      INSERT INTO leads (id, client_id, phone, score, stage, calcom_booking_id)
      VALUES ('lead1', 'client1', '+12125551234', 8, 'warm', null)
    `).run();

    const now = new Date().toISOString();
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();

    db.prepare(`
      INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, summary, outcome, score, created_at)
      VALUES ('call1', 'call1', 'client1', '+12125551234', 'inbound', 300, 'Good', 'qualified', 8, ?)
    `).run(twoDaysAgo);

    db.prepare(`
      INSERT INTO messages (id, client_id, phone, direction, body, status, created_at)
      VALUES ('msg1', 'client1', '+12125551234', 'inbound', 'Hi', 'received', ?)
    `).run(twoDaysAgo);

    const memory = getLeadMemory(db, '2125551234', 'client1');
    const insights = memory.insights;

    expect(insights.totalCalls).toBe(1);
    expect(insights.totalMessages).toBe(1);
    expect(insights.totalInteractions).toBe(2);
    expect(insights.highIntent).toBe(true); // score >= 7
    expect(insights.multiChannel).toBe(true); // has calls and messages
    expect(insights.lastInteraction).toBeDefined();
    expect(insights.daysSinceLastContact).toBe(2);
  });

  it('should detect booked status', () => {
    db.prepare(`
      INSERT INTO leads (id, client_id, phone, score, stage, calcom_booking_id)
      VALUES ('lead1', 'client1', '+12125551234', 9, 'booked', 'booking123')
    `).run();

    const memory = getLeadMemory(db, '2125551234', 'client1');

    expect(memory.insights.hasBooked).toBe(true);
  });

  it('should detect transferred status', () => {
    db.prepare(`
      INSERT INTO leads (id, client_id, phone, score, stage)
      VALUES ('lead1', 'client1', '+12125551234', 5, 'new')
    `).run();

    db.prepare(`
      INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, summary, outcome, score, created_at)
      VALUES ('call1', 'call1', 'client1', '+12125551234', 'inbound', 300, 'Transferred', 'transferred', 0, datetime('now'))
    `).run();

    const memory = getLeadMemory(db, '2125551234', 'client1');

    expect(memory.insights.hasBeenTransferred).toBe(true);
  });

  it('should count pending followups', () => {
    db.prepare(`
      INSERT INTO leads (id, client_id, phone, score, stage)
      VALUES ('lead1', 'client1', '+12125551234', 5, 'new')
    `).run();

    db.prepare(`
      INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, scheduled_at, status, created_at)
      VALUES
        ('fu1', 'lead1', 'client1', 1, 'sms', 'First', datetime('now'), 'scheduled', datetime('now')),
        ('fu2', 'lead1', 'client1', 2, 'sms', 'Second', datetime('now'), 'scheduled', datetime('now')),
        ('fu3', 'lead1', 'client1', 3, 'sms', 'Sent', datetime('now'), 'sent', datetime('now'))
    `).run();

    const memory = getLeadMemory(db, '2125551234', 'client1');

    expect(memory.insights.pendingFollowups).toBe(2);
  });

  it('should detect slipping away (no contact for 2+ days)', () => {
    db.prepare(`
      INSERT INTO leads (id, client_id, phone, score, stage)
      VALUES ('lead1', 'client1', '+12125551234', 5, 'warm')
    `).run();

    const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
    db.prepare(`
      INSERT INTO messages (id, client_id, phone, direction, body, status, created_at)
      VALUES ('msg1', 'client1', '+12125551234', 'inbound', 'Hi', 'received', ?)
    `).run(threeDaysAgo);

    const memory = getLeadMemory(db, '2125551234', 'client1');

    expect(memory.insights.slippingAway).toBe(true);
    expect(memory.insights.daysSinceLastContact).toBe(3);
  });

  it('should not mark as slipping if booked', () => {
    db.prepare(`
      INSERT INTO leads (id, client_id, phone, score, stage, calcom_booking_id)
      VALUES ('lead1', 'client1', '+12125551234', 9, 'booked', 'booking123')
    `).run();

    const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
    db.prepare(`
      INSERT INTO messages (id, client_id, phone, direction, body, status, created_at)
      VALUES ('msg1', 'client1', '+12125551234', 'inbound', 'Hi', 'received', ?)
    `).run(threeDaysAgo);

    const memory = getLeadMemory(db, '2125551234', 'client1');

    expect(memory.insights.slippingAway).toBe(false);
  });

  it('should return client information', () => {
    const memory = getLeadMemory(db, '2125551234', 'client1');

    expect(memory.client).toBeDefined();
    expect(memory.client.id).toBe('client1');
    expect(memory.client.name).toBe('Test Business');
    expect(memory.client.owner_name).toBe('John Owner');
  });

  it('should limit results to prevent memory bloat', () => {
    db.prepare(`
      INSERT INTO leads (id, client_id, phone, score, stage)
      VALUES ('lead1', 'client1', '+12125551234', 5, 'new')
    `).run();

    // Insert 50 messages
    for (let i = 0; i < 50; i++) {
      db.prepare(`
        INSERT INTO messages (id, client_id, phone, direction, body, status, created_at)
        VALUES (?, 'client1', '+12125551234', 'inbound', 'Message', 'received', datetime('now'))
      `).run(`msg${i}`);
    }

    const memory = getLeadMemory(db, '2125551234', 'client1');

    expect(memory.messages.length).toBeLessThanOrEqual(30);
  });
});
