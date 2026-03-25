const Database = require('better-sqlite3');
const {
  getConversationIntelligence,
  analyzeResponseTimeImpact,
  getPeakHours,
  getCallDurationTrend,
} = require('../utils/conversationIntelligence');
const { runMigrations } = require('../utils/migrations');

describe('Conversation Intelligence Module', () => {
  let db;

  beforeAll(() => {
    db = new Database(':memory:');
    runMigrations(db);

    // Insert test client
    db.prepare(`
      INSERT INTO clients (id, name, owner_name)
      VALUES ('client1', 'Test Business', 'John Owner')
    `).run();

    // Insert test lead
    db.prepare(`
      INSERT INTO leads (id, client_id, phone, score, stage, name)
      VALUES ('lead1', 'client1', '+12125551234', 5, 'new', 'Test Lead')
    `).run();
  });

  afterAll(() => {
    db.close();
  });

  describe('getConversationIntelligence', () => {
    it('should return full conversation intelligence report', () => {
      const now = new Date().toISOString();

      // Insert calls
      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, sentiment, created_at)
        VALUES (?, ?, 'client1', '+12125551234', 'inbound', 300, 'booked', 'positive', ?)
      `).run('call1', 'call1_id', now);

      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, sentiment, created_at)
        VALUES (?, ?, 'client1', '+12125551235', 'inbound', 150, 'not_interested', 'negative', ?)
      `).run('call2', 'call2_id', now);

      // Insert messages
      db.prepare(`
        INSERT INTO messages (id, client_id, phone, direction, body, status, created_at)
        VALUES (?, 'client1', '+12125551234', 'outbound', 'Hello', 'sent', ?)
      `).run('msg1', now);

      const result = getConversationIntelligence(db, 'client1', 30);

      expect(result).toBeDefined();
      expect(result.summary).toBeDefined();
      expect(result.summary.total_calls).toBeGreaterThanOrEqual(0);
      expect(result.summary.total_messages).toBeGreaterThanOrEqual(0);
      expect(result.summary.booking_rate).toBeDefined();
      expect(result.summary.avg_call_duration_seconds).toBeGreaterThanOrEqual(0);
      expect(result.sentiment_distribution).toBeDefined();
      expect(result.sentiment_distribution.positive).toBeDefined();
      expect(result.sentiment_distribution.neutral).toBeDefined();
      expect(result.sentiment_distribution.negative).toBeDefined();
      expect(result.call_duration_stats).toBeDefined();
      expect(result.peak_hours).toBeDefined();
      expect(Array.isArray(result.peak_hours)).toBe(true);
      expect(result.coaching_tips).toBeDefined();
      expect(Array.isArray(result.coaching_tips)).toBe(true);
    });

    it('should require db and clientId parameters', () => {
      expect(() => {
        getConversationIntelligence(null, 'client1');
      }).toThrow();

      expect(() => {
        getConversationIntelligence(db, null);
      }).toThrow();
    });

    it('should handle empty data gracefully', () => {
      const result = getConversationIntelligence(db, 'nonexistent_client', 30);

      expect(result.summary.total_calls).toBe(0);
      expect(result.summary.total_messages).toBe(0);
      expect(result.sentiment_distribution.positive).toBe(0);
      expect(result.coaching_tips).toBeDefined();
    });

    it('should calculate sentiment distribution correctly', () => {
      const now = new Date().toISOString();
      db.prepare(`DELETE FROM calls WHERE client_id = 'client_sentiment'`).run();

      db.prepare(`
        INSERT INTO clients (id, name, owner_name)
        VALUES ('client_sentiment', 'Sentiment Client', 'Owner')
      `).run();

      // Insert 3 positive, 1 neutral, 1 negative
      for (let i = 0; i < 3; i++) {
        db.prepare(`
          INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, sentiment, created_at)
          VALUES (?, ?, 'client_sentiment', '+12125551300', 'inbound', 300, 'booked', 'positive', ?)
        `).run(`sentiment_call_pos${i}`, `sentiment_call_pos${i}_id`, now);
      }

      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, sentiment, created_at)
        VALUES (?, ?, 'client_sentiment', '+12125551300', 'inbound', 200, 'qualified', 'neutral', ?)
      `).run('sentiment_call_neu', 'sentiment_call_neu_id', now);

      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, sentiment, created_at)
        VALUES (?, ?, 'client_sentiment', '+12125551300', 'inbound', 100, 'not_interested', 'negative', ?)
      `).run('sentiment_call_neg', 'sentiment_call_neg_id', now);

      const result = getConversationIntelligence(db, 'client_sentiment', 30);

      expect(result.sentiment_distribution.positive).toBe(60);
      expect(result.sentiment_distribution.neutral).toBe(20);
      expect(result.sentiment_distribution.negative).toBe(20);
    });

    it('should include coaching tips in response', () => {
      const result = getConversationIntelligence(db, 'client1', 30);

      expect(Array.isArray(result.coaching_tips)).toBe(true);
    });
  });

  describe('getPeakHours', () => {
    it('should return array of peak hours with call counts', () => {
      const now = new Date().toISOString();
      db.prepare(`DELETE FROM calls WHERE client_id = 'client_peaks'`).run();

      db.prepare(`
        INSERT INTO clients (id, name, owner_name)
        VALUES ('client_peaks', 'Peak Client', 'Owner')
      `).run();

      // Insert calls at various hours
      for (let hour = 9; hour < 17; hour++) {
        for (let i = 0; i < 2; i++) {
          const date = new Date(now);
          date.setHours(hour);
          db.prepare(`
            INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, created_at)
            VALUES (?, ?, 'client_peaks', '+12125551300', 'inbound', 300, 'booked', ?)
          `).run(`peak_call_${hour}_${i}`, `peak_call_${hour}_${i}_id`, date.toISOString());
        }
      }

      const result = getPeakHours(db, 'client_peaks');

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);

      if (result.length > 0) {
        const peak = result[0];
        expect(peak.hour).toBeDefined();
        expect(peak.day).toBeDefined();
        expect(peak.calls).toBeGreaterThanOrEqual(0);
        expect(peak.messages).toBeGreaterThanOrEqual(0);
        expect(peak.bookings).toBeGreaterThanOrEqual(0);
      }
    });

    it('should require db and clientId parameters', () => {
      expect(() => {
        getPeakHours(null, 'client1');
      }).toThrow();

      expect(() => {
        getPeakHours(db, null);
      }).toThrow();
    });

    it('should return empty array for client with no calls', () => {
      const result = getPeakHours(db, 'nonexistent_client');

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });
  });

  describe('analyzeResponseTimeImpact', () => {
    it('should return buckets and optimal window', () => {
      const now = new Date().toISOString();
      db.prepare(`DELETE FROM messages WHERE client_id = 'client_response'`).run();
      db.prepare(`DELETE FROM leads WHERE client_id = 'client_response'`).run();

      db.prepare(`
        INSERT INTO clients (id, name, owner_name)
        VALUES ('client_response', 'Response Client', 'Owner')
      `).run();

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name)
        VALUES ('lead_resp', 'client_response', '+12125551350', 5, 'new', 'Response Lead')
      `).run();

      // Insert message pairs (outbound then inbound response)
      const outboundTime = new Date(now);
      const inboundTime = new Date(outboundTime.getTime() + 5 * 60000); // 5 minutes later

      db.prepare(`
        INSERT INTO messages (id, client_id, phone, direction, body, status, created_at)
        VALUES (?, 'client_response', '+12125551350', 'outbound', 'Hello', 'sent', ?)
      `).run('response_out1', outboundTime.toISOString());

      db.prepare(`
        INSERT INTO messages (id, client_id, phone, direction, body, status, created_at)
        VALUES (?, 'client_response', '+12125551350', 'inbound', 'Hi back', 'received', ?)
      `).run('response_in1', inboundTime.toISOString());

      const result = analyzeResponseTimeImpact(db, 'client_response');

      expect(result).toBeDefined();
      expect(Array.isArray(result.buckets)).toBe(true);
      expect(result.optimal_window).toBeDefined();
      expect(result.total_responses_analyzed).toBeGreaterThanOrEqual(0);

      // Check bucket structure
      if (result.buckets.length > 0) {
        const bucket = result.buckets[0];
        expect(bucket.range).toBeDefined();
        expect(bucket.count).toBeGreaterThanOrEqual(0);
        expect(bucket.conversion_rate).toBeDefined();
      }
    });

    it('should require db and clientId parameters', () => {
      expect(() => {
        analyzeResponseTimeImpact(null, 'client1');
      }).toThrow();

      expect(() => {
        analyzeResponseTimeImpact(db, null);
      }).toThrow();
    });

    it('should return valid buckets for empty client', () => {
      const result = analyzeResponseTimeImpact(db, 'empty_response_client');

      expect(Array.isArray(result.buckets)).toBe(true);
      expect(result.buckets.length).toBeGreaterThan(0);
      expect(result.optimal_window).toBeDefined();
    });
  });

  describe('getCallDurationTrend', () => {
    it('should return weekly trend data', () => {
      const now = new Date().toISOString();
      db.prepare(`DELETE FROM calls WHERE client_id = 'client_trend'`).run();

      db.prepare(`
        INSERT INTO clients (id, name, owner_name)
        VALUES ('client_trend', 'Trend Client', 'Owner')
      `).run();

      // Insert calls from different weeks
      for (let i = 0; i < 5; i++) {
        db.prepare(`
          INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, created_at)
          VALUES (?, ?, 'client_trend', '+12125551300', 'inbound', 300, 'booked', ?)
        `).run(`trend_call_${i}`, `trend_call_${i}_id`, now);
      }

      const result = getCallDurationTrend(db, 'client_trend', 30);

      expect(Array.isArray(result)).toBe(true);

      if (result.length > 0) {
        const week = result[0];
        expect(week.week).toBeDefined();
        expect(week.avg_duration).toBeGreaterThanOrEqual(0);
        expect(week.call_count).toBeGreaterThanOrEqual(0);
        expect(week.min_duration).toBeGreaterThanOrEqual(0);
        expect(week.max_duration).toBeGreaterThanOrEqual(0);
      }
    });

    it('should return empty array for client with no calls', () => {
      const result = getCallDurationTrend(db, 'nonexistent_trend', 30);

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });

    it('should require db and clientId parameters', () => {
      expect(() => {
        getCallDurationTrend(null, 'client1', 30);
      }).toThrow();

      expect(() => {
        getCallDurationTrend(db, null, 30);
      }).toThrow();
    });
  });
});
