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

  it('should handle null phone gracefully', () => {
    const memory = getLeadMemory(db, null, 'client1');
    expect(memory).toBeNull();
  });

  it('should handle empty string phone gracefully', () => {
    const memory = getLeadMemory(db, '', 'client1');
    expect(memory).toBeNull();
  });

  it('should create lead with INSERT ON CONFLICT', () => {
    const phone = '5558888';
    // First call creates lead
    const memory1 = getLeadMemory(db, phone, 'client1');
    if (memory1) {
      expect(memory1.lead).toBeDefined();

      // Second call returns existing lead
      const memory2 = getLeadMemory(db, phone, 'client1');
      if (memory2) {
        expect(memory2.lead.id).toBe(memory1.lead.id);
      }
    }
  });

  it('should handle various phone formats', () => {
    const formats = [
      '2125551234',
      '+12125551234',
      '(212) 555-1234',
      '212-555-1234',
    ];

    formats.forEach((format, idx) => {
      const memory = getLeadMemory(db, format, 'client1');
      if (memory) {
        expect(memory.lead.phone).toMatch(/^\+1212555/);
      }
    });
  });

  it('should fetch calls in reverse chronological order (DESC)', () => {
    db.prepare(`
      INSERT INTO leads (id, client_id, phone, score, stage)
      VALUES ('lead_order', 'client1', '+12125551500', 5, 'new')
    `).run();

    const t1 = new Date('2024-01-01T10:00:00Z').toISOString();
    const t2 = new Date('2024-01-02T10:00:00Z').toISOString();
    const t3 = new Date('2024-01-03T10:00:00Z').toISOString();

    db.prepare(`
      INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, summary, outcome, score, created_at)
      VALUES
        (?, ?, 'client1', '+12125551500', 'inbound', 300, 'Call 1', 'qualified', 8, ?),
        (?, ?, 'client1', '+12125551500', 'inbound', 300, 'Call 2', 'qualified', 8, ?),
        (?, ?, 'client1', '+12125551500', 'inbound', 300, 'Call 3', 'qualified', 8, ?)
    `).run(
      'call1', 'call1_id', t1,
      'call2', 'call2_id', t2,
      'call3', 'call3_id', t3
    );

    const memory = getLeadMemory(db, '2125551500', 'client1');
    expect(memory.calls.length).toBe(3);
    // Calls should be in DESC order (most recent first)
    expect(memory.calls[0].id).toBe('call3');
    expect(memory.calls[2].id).toBe('call1');
  });

  it('should fetch messages in reverse chronological order (DESC)', () => {
    const t1 = new Date('2024-01-01T10:00:00Z').toISOString();
    const t2 = new Date('2024-01-02T10:00:00Z').toISOString();

    db.prepare(`
      INSERT INTO messages (id, client_id, phone, direction, body, status, created_at)
      VALUES
        (?, 'client1', '+12125551501', 'inbound', 'Msg 1', 'received', ?),
        (?, 'client1', '+12125551501', 'inbound', 'Msg 2', 'received', ?)
    `).run('msg_a', t1, 'msg_b', t2);

    const memory = getLeadMemory(db, '2125551501', 'client1');
    expect(memory.messages.length).toBe(2);
    // Messages should be DESC (most recent first)
    expect(memory.messages[0].id).toBe('msg_b');
    expect(memory.messages[1].id).toBe('msg_a');
  });

  it('should format call summaries with duration and outcome', () => {
    db.prepare(`
      INSERT INTO leads (id, client_id, phone, score, stage)
      VALUES ('lead_summary', 'client1', '+12125551502', 5, 'new')
    `).run();

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, summary, outcome, score, created_at)
      VALUES (?, ?, 'client1', '+12125551502', 'inbound', 125, null, 'qualified', 8, ?)
    `).run('call_fmt', 'call_fmt_id', now);

    const memory = getLeadMemory(db, '2125551502', 'client1');
    const callEvent = memory.timeline.find(t => t.type === 'call');
    expect(callEvent.summary).toContain('2m');
    expect(callEvent.summary).toContain('qualified');
  });

  it('should include message direction in timeline', () => {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO messages (id, client_id, phone, direction, body, status, created_at)
      VALUES
        (?, 'client1', '+12125551503', 'inbound', 'Inbound msg', 'received', ?),
        (?, 'client1', '+12125551503', 'outbound', 'Outbound msg', 'sent', ?)
    `).run('msg_in', now, 'msg_out', now);

    const memory = getLeadMemory(db, '2125551503', 'client1');
    const messages = memory.timeline.filter(t => t.type === 'message');
    expect(messages.some(m => m.direction === 'inbound')).toBe(true);
    expect(messages.some(m => m.direction === 'outbound')).toBe(true);
  });

  it('should only include sent followups in timeline', () => {
    db.prepare(`
      INSERT INTO leads (id, client_id, phone, score, stage)
      VALUES ('lead_fu', 'client1', '+12125551504', 5, 'new')
    `).run();

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, scheduled_at, sent_at, status, created_at)
      VALUES
        (?, 'lead_fu', 'client1', 1, 'sms', 'Sent touch', ?, ?, 'sent', ?),
        (?, 'lead_fu', 'client1', 2, 'sms', 'Scheduled touch', ?, null, 'scheduled', ?)
    `).run('fu_sent', now, now, now, 'fu_sched', now, now);

    const memory = getLeadMemory(db, '2125551504', 'client1');
    const followupEvents = memory.timeline.filter(t => t.type === 'followup_sent');
    expect(followupEvents.length).toBe(1);
    expect(followupEvents[0].touch).toBe(1);
  });

  it('should calculate daysSinceLastContact accurately', () => {
    db.prepare(`
      INSERT INTO leads (id, client_id, phone, score, stage)
      VALUES ('lead_days', 'client1', '+12125551505', 5, 'new')
    `).run();

    const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
    db.prepare(`
      INSERT INTO messages (id, client_id, phone, direction, body, status, created_at)
      VALUES (?, 'client1', '+12125551505', 'inbound', 'Hi', 'received', ?)
    `).run('msg_days', threeDaysAgo);

    const memory = getLeadMemory(db, '2125551505', 'client1');
    expect(memory.insights.daysSinceLastContact).toBe(3);
  });

  it('should handle null daysSinceLastContact when no interactions', () => {
    db.prepare(`
      INSERT INTO leads (id, client_id, phone, score, stage)
      VALUES ('lead_no_interact', 'client1', '+12125551506', 0, 'new')
    `).run();

    const memory = getLeadMemory(db, '2125551506', 'client1');
    expect(memory.insights.daysSinceLastContact).toBeNull();
  });

  it('should correctly identify highIntent (score >= 7)', () => {
    const testCases = [
      { score: 6, shouldBeHigh: false },
      { score: 7, shouldBeHigh: true },
      { score: 10, shouldBeHigh: true },
    ];

    testCases.forEach((testCase, idx) => {
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage)
        VALUES (?, 'client1', ?, ?, 'new')
      `).run(`lead_intent_${idx}`, `+1212555${1510 + idx}`, testCase.score);

      const memory = getLeadMemory(db, `${1510 + idx}`, 'client1');
      if (memory) {
        expect(memory.insights.highIntent).toBe(testCase.shouldBeHigh);
      }
    });
  });

  it('should correctly identify slippingAway (2+ days, not booked)', () => {
    db.prepare(`
      INSERT INTO leads (id, client_id, phone, score, stage)
      VALUES ('slip_warm', 'client1', '+12125551520', 5, 'warm')
    `).run();

    const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
    db.prepare(`
      INSERT INTO messages (id, client_id, phone, direction, body, status, created_at)
      VALUES (?, 'client1', '+12125551520', 'inbound', 'Hi', 'received', ?)
    `).run('msg_slip', twoDaysAgo);

    const memory = getLeadMemory(db, '2125551520', 'client1');
    expect(memory.insights.slippingAway).toBe(true);
  });

  it('should handle booked status via stage', () => {
    db.prepare(`
      INSERT INTO leads (id, client_id, phone, score, stage)
      VALUES ('lead_booked_stage', 'client1', '+12125551521', 9, 'booked')
    `).run();

    const memory = getLeadMemory(db, '2125551521', 'client1');
    expect(memory.insights.hasBooked).toBe(true);
  });

  it('should return client data', () => {
    const memory = getLeadMemory(db, '2125551234', 'client1');
    expect(memory.client).toBeDefined();
    expect(memory.client.name).toBe('Test Business');
    expect(memory.client.owner_name).toBe('John Owner');
  });

  it('should handle missing client gracefully', () => {
    const memory = getLeadMemory(db, '2125551234', 'nonexistent');
    // Client is expected to be null or undefined when not found
    expect(memory.client === null || memory.client === undefined).toBe(true);
  });

  it('should include all required memory fields', () => {
    const memory = getLeadMemory(db, '2125551234', 'client1');
    expect(memory).toHaveProperty('lead');
    expect(memory).toHaveProperty('client');
    expect(memory).toHaveProperty('calls');
    expect(memory).toHaveProperty('messages');
    expect(memory).toHaveProperty('followups');
    expect(memory).toHaveProperty('timeline');
    expect(memory).toHaveProperty('insights');
  });

  it('should have lastInteraction in insights', () => {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO leads (id, client_id, phone, score, stage)
      VALUES ('lead_last', 'client1', '+12125551525', 5, 'new')
    `).run();

    db.prepare(`
      INSERT INTO messages (id, client_id, phone, direction, body, status, created_at)
      VALUES (?, 'client1', '+12125551525', 'inbound', 'Hi', 'received', ?)
    `).run('msg_last', now);

    const memory = getLeadMemory(db, '2125551525', 'client1');
    expect(memory.insights.lastInteraction).toBeDefined();
    expect(memory.insights.lastInteraction.type).toBe('message');
  });
});
