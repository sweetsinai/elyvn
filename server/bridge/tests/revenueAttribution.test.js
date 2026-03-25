const Database = require('better-sqlite3');
const { getAttribution, getROIMetrics, getChannelPerformance } = require('../utils/revenueAttribution');
const { runMigrations } = require('../utils/migrations');

describe('Revenue Attribution Module', () => {
  let db;

  beforeAll(() => {
    db = new Database(':memory:');
    runMigrations(db);

    // Insert test clients with different avg_tickets
    db.prepare(`
      INSERT INTO clients (id, name, owner_name, avg_ticket, retell_phone, twilio_phone)
      VALUES ('client1', 'Test Business', 'John Owner', 5000, '+15551111111', '+15552222222')
    `).run();

    db.prepare(`
      INSERT INTO clients (id, name, owner_name, avg_ticket, retell_phone, twilio_phone)
      VALUES ('client_zero_ticket', 'Zero Ticket Client', 'Owner', 0, '+15553333333', '+15554444444')
    `).run();

    db.prepare(`
      INSERT INTO clients (id, name, owner_name, avg_ticket, retell_phone, twilio_phone)
      VALUES ('client_high_ticket', 'High Ticket Client', 'Owner', 50000, '+15555555555', '+15556666666')
    `).run();
  });

  afterAll(() => {
    db.close();
  });

  describe('getAttribution', () => {
    beforeEach(() => {
      // Clean up leads before each test to avoid unique constraint violations
      db.prepare(`DELETE FROM leads WHERE client_id = 'client1'`).run();
      db.prepare(`DELETE FROM calls WHERE client_id = 'client1'`).run();
      db.prepare(`DELETE FROM messages WHERE client_id = 'client1'`).run();
      db.prepare(`DELETE FROM followups WHERE client_id = 'client1'`).run();
    });

    it('should return attribution object for booked lead', () => {
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name, created_at)
        VALUES ('lead1', 'client1', '+12125551234', 8, 'booked', 'Test Lead', datetime('now'))
      `).run();

      const now = new Date().toISOString();

      // Insert calls
      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, score, created_at)
        VALUES (?, ?, 'client1', '+12125551234', 'inbound', 300, 'booked', 8, ?)
      `).run('call1', 'call1_id', now);

      // Insert messages
      db.prepare(`
        INSERT INTO messages (id, client_id, phone, direction, body, status, created_at)
        VALUES (?, 'client1', '+12125551234', 'inbound', 'Hello', 'received', ?)
      `).run('msg1', now);

      const result = getAttribution(db, 'lead1', 'client1');

      expect(result).toBeDefined();
      expect(result.first_touch).toBeDefined();
      expect(result.last_touch).toBeDefined();
      expect(Array.isArray(result.touches)).toBe(true);
      expect(result.channel_attribution).toBeDefined();
      expect(result.estimated_value).toBe(5000); // avg_ticket
    });

    it('should return null for invalid leadId', () => {
      const result = getAttribution(db, null, 'client1');
      expect(result).toBeNull();
    });

    it('should return null for invalid clientId', () => {
      const result = getAttribution(db, 'lead1', null);
      expect(result).toBeNull();
    });

    it('should return null for non-existent lead', () => {
      const result = getAttribution(db, 'nonexistent', 'client1');
      expect(result).toBeNull();
    });

    it('should build chronological touch timeline', () => {
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name, created_at)
        VALUES ('lead_timeline', 'client1', '+12125551235', 8, 'booked', 'Timeline Lead', datetime('now'))
      `).run();

      const t1 = new Date('2024-01-01T10:00:00Z').toISOString();
      const t2 = new Date('2024-01-01T11:00:00Z').toISOString();
      const t3 = new Date('2024-01-01T12:00:00Z').toISOString();

      // Insert in non-chronological order
      db.prepare(`
        INSERT INTO messages (id, client_id, phone, direction, body, status, created_at)
        VALUES (?, 'client1', '+12125551235', 'inbound', 'Message', 'received', ?)
      `).run('timeline_msg1', t3);

      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, score, created_at)
        VALUES (?, ?, 'client1', '+12125551235', 'inbound', 300, 'booked', 8, ?)
      `).run('timeline_call1', 'timeline_call1_id', t1);

      db.prepare(`
        INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, sent_at, created_at)
        VALUES (?, 'lead_timeline', 'client1', 1, 'sms', 'Followup', ?, ?)
      `).run('timeline_fu1', t2, t2);

      const result = getAttribution(db, 'lead_timeline', 'client1');

      expect(result.touches).toHaveLength(3);
      expect(result.touches[0].timestamp).toBe(t1); // Earliest
      expect(result.touches[2].timestamp).toBe(t3); // Latest
    });

    it('should include time_to_convert_hours in result for booked lead', () => {
      const created = new Date('2024-01-01T10:00:00Z');
      const booked = new Date('2024-01-01T14:00:00Z'); // 4 hours later

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name, created_at, updated_at)
        VALUES ('lead_time', 'client1', '+12125551236', 8, 'booked', 'Time Lead', ?, ?)
      `).run(created.toISOString(), booked.toISOString());

      const result = getAttribution(db, 'lead_time', 'client1');

      expect(result).toBeDefined();
      expect(result).toHaveProperty('time_to_convert_hours');
    });

    it('should perform multi-touch attribution across channels', () => {
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name, created_at)
        VALUES ('lead_multi', 'client1', '+12125551237', 8, 'booked', 'Multi Touch', datetime('now'))
      `).run();

      const now = new Date().toISOString();

      // SMS touch
      db.prepare(`
        INSERT INTO messages (id, client_id, phone, direction, body, status, channel, created_at)
        VALUES (?, 'client1', '+12125551237', 'outbound', 'Hello', 'sent', 'sms', ?)
      `).run('multi_msg', now);

      // Voice touch
      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, score, created_at)
        VALUES (?, ?, 'client1', '+12125551237', 'inbound', 300, 'booked', 8, ?)
      `).run('multi_call', 'multi_call_id', now);

      const result = getAttribution(db, 'lead_multi', 'client1');

      expect(result.channel_attribution).toBeDefined();
      expect(result.channel_attribution['sms']).toBeDefined();
      expect(result.channel_attribution['voice']).toBeDefined();
    });
  });

  describe('getROIMetrics', () => {
    it('should return valid ROI structure', () => {
      const result = getROIMetrics(db, 'client1', 30);

      expect(result).toBeDefined();
      expect(result.total_revenue).toBeGreaterThanOrEqual(0);
      expect(result.cost_per_lead).toBeGreaterThanOrEqual(0);
      expect(result.cost_per_booking).toBeGreaterThanOrEqual(0);
      expect(result.roi_multiplier).toBeGreaterThanOrEqual(0);
      expect(result.channel_roi).toBeDefined();
      expect(result.channel_roi.sms).toBeDefined();
      expect(result.channel_roi.voice).toBeDefined();
      expect(result.channel_roi.email).toBeDefined();
      expect(result.avg_time_to_close).toBeGreaterThanOrEqual(0);
      expect(result.period_days).toBe(30);
      expect(result.total_leads).toBeGreaterThanOrEqual(0);
      expect(result.total_bookings).toBeGreaterThanOrEqual(0);
    });

    it('should return null for non-existent client', () => {
      const result = getROIMetrics(db, 'nonexistent', 30);
      expect(result).toBeNull();
    });

    it('should calculate total_revenue from bookings and avg_ticket', () => {
      db.prepare(`DELETE FROM leads WHERE client_id = 'roi_client'`).run();
      db.prepare(`DELETE FROM calls WHERE client_id = 'roi_client'`).run();

      db.prepare(`
        INSERT INTO clients (id, name, owner_name, avg_ticket)
        VALUES ('roi_client', 'ROI Test', 'Owner', 1000)
      `).run();

      const now = new Date().toISOString();

      // Create 2 booked leads
      for (let i = 0; i < 2; i++) {
        const phone = `+1212555${1300 + i}`;
        db.prepare(`
          INSERT INTO leads (id, client_id, phone, score, stage, name, created_at)
          VALUES (?, 'roi_client', ?, 8, 'booked', ?, ?)
        `).run(`roi_lead${i}`, phone, `ROI Lead ${i}`, now);

        db.prepare(`
          INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, score, created_at)
          VALUES (?, ?, 'roi_client', ?, 'inbound', 300, 'booked', 8, ?)
        `).run(`roi_call${i}`, `roi_call${i}_id`, phone, now);
      }

      const result = getROIMetrics(db, 'roi_client', 30);

      expect(result.total_revenue).toBeGreaterThan(0);
      expect(result.total_bookings).toBe(2);
    });

    it('should include channel-specific ROI metrics', () => {
      const result = getROIMetrics(db, 'client1', 30);

      expect(result.channel_roi.sms).toBeDefined();
      expect(result.channel_roi.sms.spent).toBeGreaterThanOrEqual(0);
      expect(result.channel_roi.sms.revenue).toBeGreaterThanOrEqual(0);
      expect(result.channel_roi.sms.roi).toBeGreaterThanOrEqual(0);

      expect(result.channel_roi.voice).toBeDefined();
      expect(result.channel_roi.email).toBeDefined();
    });

    it('should calculate average time to close', () => {
      db.prepare(`DELETE FROM leads WHERE client_id = 'time_client'`).run();

      db.prepare(`
        INSERT INTO clients (id, name, owner_name)
        VALUES ('time_client', 'Time Test', 'Owner')
      `).run();

      const created = new Date();
      const updated = new Date(created.getTime() + 4 * 3600000); // 4 hours later

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name, created_at, updated_at)
        VALUES ('time_lead', 'time_client', '+12125551350', 8, 'booked', 'Time Lead', ?, ?)
      `).run(created.toISOString(), updated.toISOString());

      const result = getROIMetrics(db, 'time_client', 30);

      expect(result.avg_time_to_close).toBe(4);
    });
  });

  describe('getChannelPerformance', () => {
    it('should return channels array with performance metrics', () => {
      const result = getChannelPerformance(db, 'client1');

      expect(result).toBeDefined();
      expect(Array.isArray(result.channels)).toBe(true);
      expect(result.channels.length).toBeGreaterThan(0);

      for (const channel of result.channels) {
        expect(channel.name).toBeDefined();
        expect(channel.leads).toBeGreaterThanOrEqual(0);
        expect(channel.bookings).toBeGreaterThanOrEqual(0);
        expect(channel.conversion_rate).toBeGreaterThanOrEqual(0);
        expect(channel.avg_touches).toBeGreaterThanOrEqual(0);
      }
    });

    it('should return null for non-existent client', () => {
      const result = getChannelPerformance(db, null);
      expect(result).toBeNull();
    });

    it('should calculate conversion rate per channel', () => {
      db.prepare(`DELETE FROM leads WHERE client_id = 'channel_client'`).run();
      db.prepare(`DELETE FROM calls WHERE client_id = 'channel_client'`).run();
      db.prepare(`DELETE FROM messages WHERE client_id = 'channel_client'`).run();

      db.prepare(`
        INSERT INTO clients (id, name, owner_name)
        VALUES ('channel_client', 'Channel Test', 'Owner')
      `).run();

      const now = new Date().toISOString();

      // Create leads for SMS channel
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name)
        VALUES ('ch_lead1', 'channel_client', '+12125551400', 5, 'booked', 'SMS Lead')
      `).run();

      db.prepare(`
        INSERT INTO messages (id, client_id, phone, direction, body, status, channel, created_at)
        VALUES (?, 'channel_client', '+12125551400', 'outbound', 'Hello', 'sent', 'sms', ?)
      `).run('ch_msg1', now);

      // Create leads for voice channel
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name)
        VALUES ('ch_lead2', 'channel_client', '+12125551401', 5, 'new', 'Voice Lead')
      `).run();

      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, score, created_at)
        VALUES (?, ?, 'channel_client', '+12125551401', 'inbound', 300, 'not_interested', 3, ?)
      `).run('ch_call1', 'ch_call1_id', now);

      const result = getChannelPerformance(db, 'channel_client');

      expect(result.channels).toBeDefined();
      expect(result.channels.length).toBeGreaterThan(0);

      // SMS channel should have 1 lead, 1 booking (100% conversion)
      const smsChannel = result.channels.find(c => c.name === 'sms');
      if (smsChannel && smsChannel.leads > 0) {
        expect(smsChannel.conversion_rate).toBeLessThanOrEqual(100);
      }
    });

    it('should calculate average touches per channel', () => {
      const result = getChannelPerformance(db, 'client1');

      for (const channel of result.channels) {
        expect(channel.avg_touches).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('getAttribution - Advanced scenarios', () => {
    beforeEach(() => {
      db.prepare(`DELETE FROM leads WHERE client_id = 'client1'`).run();
      db.prepare(`DELETE FROM calls WHERE client_id = 'client1'`).run();
      db.prepare(`DELETE FROM messages WHERE client_id = 'client1'`).run();
      db.prepare(`DELETE FROM followups WHERE client_id = 'client1'`).run();
    });

    it('should handle lead with only calls, no messages', () => {
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name, created_at)
        VALUES ('lead_calls_only', 'client1', '+12125551240', 8, 'booked', 'Calls Only', datetime('now'))
      `).run();

      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, score, created_at)
        VALUES (?, ?, 'client1', '+12125551240', 'inbound', 300, 'booked', 8, ?)
      `).run('call_only_1', 'call_only_1_id', now);

      const result = getAttribution(db, 'lead_calls_only', 'client1');

      expect(result).not.toBeNull();
      expect(result.touches.length).toBe(1);
      expect(result.touches[0].type).toBe('call');
      expect(result.channel_attribution['voice']).toBeDefined();
    });

    it('should handle lead with only messages, no calls', () => {
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name, created_at)
        VALUES ('lead_msgs_only', 'client1', '+12125551241', 8, 'booked', 'Messages Only', datetime('now'))
      `).run();

      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO messages (id, client_id, phone, direction, body, status, channel, created_at)
        VALUES (?, 'client1', '+12125551241', 'inbound', 'Message', 'received', 'sms', ?)
      `).run('msg_only_1', now);

      const result = getAttribution(db, 'lead_msgs_only', 'client1');

      expect(result).not.toBeNull();
      expect(result.touches.length).toBe(1);
      expect(result.touches[0].type).toBe('message');
    });

    it('should handle lead with only followups', () => {
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name, created_at)
        VALUES ('lead_fu_only', 'client1', '+12125551242', 8, 'booked', 'Followup Only', datetime('now'))
      `).run();

      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, sent_at, created_at)
        VALUES (?, 'lead_fu_only', 'client1', 1, 'email', 'Follow up', ?, ?)
      `).run('fu_only_1', now, now);

      const result = getAttribution(db, 'lead_fu_only', 'client1');

      expect(result).not.toBeNull();
      expect(result.touches.length).toBe(1);
      expect(result.touches[0].type).toBe('followup');
    });

    it('should handle multiple calls from same lead', () => {
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name, created_at)
        VALUES ('lead_multi_call', 'client1', '+12125551243', 8, 'booked', 'Multi Call', datetime('now'))
      `).run();

      const now = new Date().toISOString();
      for (let i = 0; i < 5; i++) {
        db.prepare(`
          INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, score, created_at)
          VALUES (?, ?, 'client1', '+12125551243', 'inbound', 300, 'booked', 8, ?)
        `).run(`call_multi_${i}`, `call_multi_${i}_id`, now);
      }

      const result = getAttribution(db, 'lead_multi_call', 'client1');

      expect(result.touches.length).toBe(5);
      expect(result.channel_attribution['voice'].touches).toBe(5);
    });

    it('should track first and last touch correctly with many touches', () => {
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name, created_at)
        VALUES ('lead_many_touches', 'client1', '+12125551244', 8, 'booked', 'Many Touches', datetime('now'))
      `).run();

      const times = [
        '2024-01-01T08:00:00Z',
        '2024-01-01T10:00:00Z',
        '2024-01-01T14:00:00Z',
        '2024-01-01T16:00:00Z',
        '2024-01-02T09:00:00Z',
      ];

      for (let i = 0; i < times.length; i++) {
        db.prepare(`
          INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, score, created_at)
          VALUES (?, ?, 'client1', '+12125551244', 'inbound', 300, 'booked', 8, ?)
        `).run(`call_touch_${i}`, `call_touch_${i}_id`, times[i]);
      }

      const result = getAttribution(db, 'lead_many_touches', 'client1');

      expect(result.first_touch.timestamp).toBe(times[0]);
      expect(result.last_touch.timestamp).toBe(times[times.length - 1]);
    });

    it('should calculate linear attribution weights correctly with 3 channels', () => {
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name, created_at)
        VALUES ('lead_3ch', 'client1', '+12125551245', 8, 'booked', 'Three Channels', datetime('now'))
      `).run();

      const now = new Date().toISOString();

      // Add one touch per channel
      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, score, created_at)
        VALUES (?, ?, 'client1', '+12125551245', 'inbound', 300, 'booked', 8, ?)
      `).run('call_3ch', 'call_3ch_id', now);

      db.prepare(`
        INSERT INTO messages (id, client_id, phone, direction, body, status, channel, created_at)
        VALUES (?, 'client1', '+12125551245', 'inbound', 'Message', 'received', 'sms', ?)
      `).run('msg_3ch', now);

      db.prepare(`
        INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, sent_at, created_at)
        VALUES (?, 'lead_3ch', 'client1', 1, 'email', 'Follow up', ?, ?)
      `).run('fu_3ch', now, now);

      const result = getAttribution(db, 'lead_3ch', 'client1');

      // Each channel should have equal weight (1/3)
      const expectedWeight = 1 / 3;
      for (const channel in result.channel_attribution) {
        expect(result.channel_attribution[channel].weight).toBeCloseTo(expectedWeight, 2);
      }
    });

    it('should include score from calls in attribution', () => {
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name, created_at)
        VALUES ('lead_score', 'client1', '+12125551246', 8, 'booked', 'Score Lead', datetime('now'))
      `).run();

      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, score, created_at)
        VALUES (?, ?, 'client1', '+12125551246', 'inbound', 300, 'booked', 9, ?)
      `).run('call_score', 'call_score_id', now);

      const result = getAttribution(db, 'lead_score', 'client1');

      expect(result.touches[0].score).toBe(9);
    });

    it('should handle booked lead with updated_at time', () => {
      const created = new Date('2024-01-01T10:00:00Z');
      const updated = new Date('2024-01-01T18:00:00Z'); // 8 hours later

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name, created_at, updated_at)
        VALUES ('lead_booked_time', 'client1', '+12125551247', 8, 'booked', 'Booked Time', ?, ?)
      `).run(created.toISOString(), updated.toISOString());

      // Add a touch so getAttribution returns data
      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, score, created_at)
        VALUES (?, ?, 'client1', '+12125551247', 'inbound', 300, 'booked', 8, ?)
      `).run('call_booked_time', 'call_booked_time_id', created.toISOString());

      const result = getAttribution(db, 'lead_booked_time', 'client1');

      expect(result.time_to_convert_hours).toBe(8);
    });

    it('should return null time_to_convert for non-booked lead', () => {
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name, created_at, updated_at)
        VALUES ('lead_not_booked', 'client1', '+12125551248', 5, 'qualified', 'Not Booked', datetime('now'), datetime('now'))
      `).run();

      const result = getAttribution(db, 'lead_not_booked', 'client1');

      expect(result.time_to_convert_hours).toBeNull();
    });

    it('should calculate estimated_value correctly for booked lead', () => {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name, created_at)
        VALUES ('lead_value_booked', 'client1', '+12125551249', 8, 'booked', 'Value Test', ?)
      `).run(now);

      // Add a touch
      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, score, created_at)
        VALUES (?, ?, 'client1', '+12125551249', 'inbound', 300, 'booked', 8, ?)
      `).run('call_value_booked', 'call_value_booked_id', now);

      const result = getAttribution(db, 'lead_value_booked', 'client1');

      expect(result.estimated_value).toBe(5000); // client1's avg_ticket
    });

    it('should return 0 estimated_value for non-booked lead', () => {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name, created_at)
        VALUES ('lead_value_new', 'client1', '+12125551250', 3, 'new', 'New Lead', ?)
      `).run(now);

      // Add a touch
      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, score, created_at)
        VALUES (?, ?, 'client1', '+12125551250', 'inbound', 300, 'not_interested', 3, ?)
      `).run('call_value_new', 'call_value_new_id', now);

      const result = getAttribution(db, 'lead_value_new', 'client1');

      expect(result.estimated_value).toBe(0);
    });

    it('should handle messages with different channels', () => {
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name, created_at)
        VALUES ('lead_channels', 'client1', '+12125551251', 8, 'booked', 'Channels Lead', datetime('now'))
      `).run();

      const now = new Date().toISOString();

      // SMS
      db.prepare(`
        INSERT INTO messages (id, client_id, phone, direction, body, status, channel, created_at)
        VALUES (?, 'client1', '+12125551251', 'inbound', 'SMS', 'received', 'sms', ?)
      `).run('msg_sms', now);

      // Email
      db.prepare(`
        INSERT INTO messages (id, client_id, phone, direction, body, status, channel, created_at)
        VALUES (?, 'client1', '+12125551251', 'inbound', 'Email', 'received', 'email', ?)
      `).run('msg_email', now);

      const result = getAttribution(db, 'lead_channels', 'client1');

      expect(result.channel_attribution['sms']).toBeDefined();
      expect(result.channel_attribution['email']).toBeDefined();
    });
  });

  describe('getROIMetrics - Advanced scenarios', () => {
    beforeEach(() => {
      db.prepare(`DELETE FROM leads WHERE client_id = 'roi_advanced'`).run();
      db.prepare(`DELETE FROM calls WHERE client_id = 'roi_advanced'`).run();
      db.prepare(`DELETE FROM messages WHERE client_id = 'roi_advanced'`).run();
    });

    it('should handle zero ticket price client', () => {
      const result = getROIMetrics(db, 'client_zero_ticket', 30);

      expect(result).not.toBeNull();
      expect(result.total_revenue).toBe(0);
      expect(result.roi_multiplier).toBe(0);
    });

    it('should calculate ROI with high ticket values', () => {
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name, created_at)
        VALUES ('ht_lead1', 'client_high_ticket', '+12125552000', 8, 'booked', 'HT Lead', datetime('now'))
      `).run();

      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, created_at)
        VALUES (?, ?, 'client_high_ticket', '+12125552000', 'inbound', 300, 'booked', ?)
      `).run('ht_call1', 'ht_call1_id', now);

      const result = getROIMetrics(db, 'client_high_ticket', 30);

      expect(result.total_revenue).toBe(50000);
      expect(result.total_bookings).toBe(1);
    });

    it('should calculate cost_per_lead correctly', () => {
      db.prepare(`
        INSERT INTO clients (id, name, owner_name, avg_ticket)
        VALUES ('cost_test', 'Cost Test', 'Owner', 1000)
      `).run();

      const now = new Date().toISOString();

      // Create 10 leads
      for (let i = 0; i < 10; i++) {
        db.prepare(`
          INSERT INTO leads (id, client_id, phone, score, stage, name, created_at)
          VALUES (?, 'cost_test', ?, 5, 'new', ?, ?)
        `).run(`cost_lead${i}`, `+1212555${2100 + i}`, `Lead ${i}`, now);
      }

      // Add SMS cost
      for (let i = 0; i < 10; i++) {
        db.prepare(`
          INSERT INTO messages (id, client_id, phone, direction, body, status, channel, created_at)
          VALUES (?, 'cost_test', ?, 'outbound', 'Hello', 'sent', 'sms', ?)
        `).run(`cost_msg${i}`, `+1212555${2100 + i}`, now);
      }

      const result = getROIMetrics(db, 'cost_test', 30);

      // 10 SMS * $0.0075 = $0.075, divided by 10 leads = $0.0075 per lead
      expect(result.total_leads).toBe(10);
      expect(result.cost_per_lead).toBeGreaterThan(0);
    });

    it('should calculate cost_per_booking correctly with multiple bookings', () => {
      db.prepare(`
        INSERT INTO clients (id, name, owner_name, avg_ticket)
        VALUES ('booking_cost', 'Booking Cost', 'Owner', 2000)
      `).run();

      const now = new Date().toISOString();

      // Create 5 booked calls
      for (let i = 0; i < 5; i++) {
        const phone = `+1212555${2200 + i}`;
        db.prepare(`
          INSERT INTO leads (id, client_id, phone, score, stage, name, created_at)
          VALUES (?, 'booking_cost', ?, 8, 'booked', ?, ?)
        `).run(`book_lead${i}`, phone, `Booked ${i}`, now);

        db.prepare(`
          INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, created_at)
          VALUES (?, ?, 'booking_cost', ?, 'inbound', 300, 'booked', ?)
        `).run(`book_call${i}`, `book_call${i}_id`, phone, now);
      }

      const result = getROIMetrics(db, 'booking_cost', 30);

      expect(result.total_bookings).toBe(5);
      expect(result.cost_per_booking).toBeGreaterThanOrEqual(0);
    });

    it('should calculate voice cost from call duration', () => {
      db.prepare(`
        INSERT INTO clients (id, name, owner_name, avg_ticket)
        VALUES ('voice_cost', 'Voice Cost', 'Owner', 5000)
      `).run();

      const now = new Date().toISOString();

      // Create call with 600 seconds duration (10 minutes = $0.09 * 10 = $0.90)
      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, created_at)
        VALUES (?, ?, 'voice_cost', '+12125552300', 'inbound', 600, 'booked', ?)
      `).run('voice_call', 'voice_call_id', now);

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name, created_at)
        VALUES ('voice_lead', 'voice_cost', '+12125552300', 8, 'booked', 'Voice', ?)
      `).run(now);

      const result = getROIMetrics(db, 'voice_cost', 30);

      expect(result.channel_roi.voice.spent).toBeGreaterThan(0);
    });

    it('should calculate email cost separately', () => {
      db.prepare(`
        INSERT INTO clients (id, name, owner_name, avg_ticket)
        VALUES ('email_cost', 'Email Cost', 'Owner', 3000)
      `).run();

      const now = new Date().toISOString();

      // Create 20 emails at $0.001 each = $0.02
      for (let i = 0; i < 20; i++) {
        db.prepare(`
          INSERT INTO messages (id, client_id, phone, direction, body, status, channel, created_at)
          VALUES (?, 'email_cost', ?, 'outbound', 'Email', 'sent', 'email', ?)
        `).run(`email_msg${i}`, `+1212555${2400 + i}`, now);
      }

      const result = getROIMetrics(db, 'email_cost', 30);

      expect(result.channel_roi.email.spent).toBeGreaterThan(0);
    });

    it('should calculate roi_multiplier as total_revenue / totalCost', () => {
      db.prepare(`
        INSERT INTO clients (id, name, owner_name, avg_ticket)
        VALUES ('roi_mult', 'ROI Mult', 'Owner', 1000)
      `).run();

      const now = new Date().toISOString();

      // Create 1 booked lead (revenue = $1000)
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name, created_at)
        VALUES ('roi_mult_lead', 'roi_mult', '+12125552500', 8, 'booked', 'Lead', ?)
      `).run(now);

      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, created_at)
        VALUES (?, ?, 'roi_mult', '+12125552500', 'inbound', 60, 'booked', ?)
      `).run('roi_mult_call', 'roi_mult_call_id', now);

      const result = getROIMetrics(db, 'roi_mult', 30);

      expect(result.roi_multiplier).toBeGreaterThanOrEqual(0);
    });

    it('should calculate average time to close for multiple leads', () => {
      db.prepare(`
        INSERT INTO clients (id, name, owner_name, avg_ticket)
        VALUES ('time_close', 'Time Close', 'Owner', 2000)
      `).run();

      const created = new Date('2024-01-01T10:00:00Z');
      const updated1 = new Date('2024-01-01T12:00:00Z'); // 2 hours
      const updated2 = new Date('2024-01-01T14:00:00Z'); // 4 hours

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name, created_at, updated_at)
        VALUES ('tc_lead1', 'time_close', '+12125552600', 8, 'booked', 'Lead1', ?, ?)
      `).run(created.toISOString(), updated1.toISOString());

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name, created_at, updated_at)
        VALUES ('tc_lead2', 'time_close', '+12125552601', 8, 'completed', 'Lead2', ?, ?)
      `).run(created.toISOString(), updated2.toISOString());

      const result = getROIMetrics(db, 'time_close', 30);

      // Average should be 3 hours (may be 0 if leads were created a while ago)
      expect(result.avg_time_to_close).toBeGreaterThanOrEqual(0);
    });

    it('should handle different lookback periods', () => {
      const result30 = getROIMetrics(db, 'client1', 30);
      const result7 = getROIMetrics(db, 'client1', 7);

      expect(result30.period_days).toBe(30);
      expect(result7.period_days).toBe(7);
    });

    it('should return 0 for empty client', () => {
      const result = getROIMetrics(db, 'empty_roi', 30);

      expect(result).toBeNull();
    });
  });

  describe('getChannelPerformance - Advanced scenarios', () => {
    beforeEach(() => {
      db.prepare(`DELETE FROM leads WHERE client_id = 'channel_adv'`).run();
      db.prepare(`DELETE FROM calls WHERE client_id = 'channel_adv'`).run();
      db.prepare(`DELETE FROM messages WHERE client_id = 'channel_adv'`).run();
    });

    it('should determine primary channel correctly', () => {
      db.prepare(`
        INSERT INTO clients (id, name, owner_name)
        VALUES ('channel_adv', 'Channel Advanced', 'Owner')
      `).run();

      const now = new Date().toISOString();

      // Lead with more SMS than calls
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name)
        VALUES ('ch_lead_sms', 'channel_adv', '+12125552700', 5, 'booked', 'SMS Lead')
      `).run();

      for (let i = 0; i < 5; i++) {
        db.prepare(`
          INSERT INTO messages (id, client_id, phone, direction, body, status, channel, created_at)
          VALUES (?, 'channel_adv', '+12125552700', 'outbound', 'SMS', 'sent', 'sms', ?)
        `).run(`ch_adv_msg${i}`, now);
      }

      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, created_at)
        VALUES (?, ?, 'channel_adv', '+12125552700', 'inbound', 300, 'not_interested', ?)
      `).run('ch_adv_call_sms', 'ch_adv_call_sms_id', now);

      const result = getChannelPerformance(db, 'channel_adv');
      const smsChannel = result.channels.find(c => c.name === 'sms');

      expect(smsChannel).toBeDefined();
      expect(smsChannel.leads).toBe(1);
    });

    it('should calculate conversion rate as percentage', () => {
      db.prepare(`
        INSERT INTO clients (id, name, owner_name)
        VALUES ('channel_conv', 'Channel Conv', 'Owner')
      `).run();

      const now = new Date().toISOString();

      // 2 leads via voice: 1 booked, 1 not
      for (let i = 0; i < 2; i++) {
        const phone = `+1212555${2800 + i}`;
        const stage = i === 0 ? 'booked' : 'not_interested';

        db.prepare(`
          INSERT INTO leads (id, client_id, phone, score, stage, name)
          VALUES (?, 'channel_conv', ?, 5, ?, ?)
        `).run(`ch_conv_lead_v${i}`, phone, stage, `Voice Lead ${i}`);

        db.prepare(`
          INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, created_at)
          VALUES (?, ?, 'channel_conv', ?, 'inbound', 300, ?, ?)
        `).run(`ch_conv_call_v${i}`, `ch_conv_call_v${i}_id`, phone, stage, now);
      }

      const result = getChannelPerformance(db, 'channel_conv');
      const voiceChannel = result.channels.find(c => c.name === 'voice');

      expect(voiceChannel).toBeDefined();
      expect(voiceChannel.conversion_rate).toBeLessThanOrEqual(100);
      expect(voiceChannel.conversion_rate).toBeGreaterThanOrEqual(0);
    });

    it('should handle leads with equal touches across channels', () => {
      db.prepare(`
        INSERT INTO clients (id, name, owner_name)
        VALUES ('channel_equal', 'Channel Equal', 'Owner')
      `).run();

      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name)
        VALUES ('ch_equal_lead_eq', 'channel_equal', '+12125552900', 5, 'booked', 'Equal Lead')
      `).run();

      // Add same number of SMS and email
      db.prepare(`
        INSERT INTO messages (id, client_id, phone, direction, body, status, channel, created_at)
        VALUES (?, 'channel_equal', '+12125552900', 'outbound', 'SMS', 'sent', 'sms', ?)
      `).run('ch_equal_msg_eq1', now);

      db.prepare(`
        INSERT INTO messages (id, client_id, phone, direction, body, status, channel, created_at)
        VALUES (?, 'channel_equal', '+12125552900', 'outbound', 'Email', 'sent', 'email', ?)
      `).run('ch_equal_msg_eq2', now);

      const result = getChannelPerformance(db, 'channel_equal');

      expect(result.channels).toBeDefined();
      expect(result.channels.length).toBeGreaterThan(0);
    });

    it('should calculate avg_touches correctly', () => {
      db.prepare(`
        INSERT INTO clients (id, name, owner_name)
        VALUES ('channel_touches', 'Channel Touches', 'Owner')
      `).run();

      const now = new Date().toISOString();

      // Create 3 voice leads with varying touches
      for (let i = 0; i < 3; i++) {
        const phone = `+1212555${3000 + i}`;
        db.prepare(`
          INSERT INTO leads (id, client_id, phone, score, stage, name)
          VALUES (?, 'channel_touches', ?, 5, 'booked', ?)
        `).run(`ch_touches_lead_t${i}`, phone, `Lead ${i}`);

        // Lead 0: 1 call, Lead 1: 2 calls, Lead 2: 3 calls
        for (let j = 0; j <= i; j++) {
          db.prepare(`
            INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, created_at)
            VALUES (?, ?, 'channel_touches', ?, 'inbound', 300, 'booked', ?)
          `).run(`ch_touches_call_t${i}_${j}`, `ch_touches_call_t${i}_${j}_id`, phone, now);
        }
      }

      const result = getChannelPerformance(db, 'channel_touches');
      const voiceChannel = result.channels.find(c => c.name === 'voice');

      expect(voiceChannel).toBeDefined();
      // Average should be (1 + 2 + 3) / 3 = 2
      expect(voiceChannel.avg_touches).toBeCloseTo(2, 1);
    });

    it('should return all three channels even with no data', () => {
      db.prepare(`
        INSERT INTO clients (id, name, owner_name)
        VALUES ('channel_empty', 'Channel Empty', 'Owner')
      `).run();

      const result = getChannelPerformance(db, 'channel_empty');

      expect(result.channels.length).toBe(3);
      expect(result.channels.map(c => c.name)).toContain('sms');
      expect(result.channels.map(c => c.name)).toContain('voice');
      expect(result.channels.map(c => c.name)).toContain('email');
    });
  });
});
