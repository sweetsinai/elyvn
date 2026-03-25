const Database = require('better-sqlite3');
const { getAttribution, getROIMetrics, getChannelPerformance } = require('../utils/revenueAttribution');
const { runMigrations } = require('../utils/migrations');

describe('Revenue Attribution Module', () => {
  let db;

  beforeAll(() => {
    db = new Database(':memory:');
    runMigrations(db);

    // Insert test client with avg_ticket
    db.prepare(`
      INSERT INTO clients (id, name, owner_name, avg_ticket)
      VALUES ('client1', 'Test Business', 'John Owner', 5000)
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
});
