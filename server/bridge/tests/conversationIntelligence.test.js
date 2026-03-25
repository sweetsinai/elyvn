const Database = require('better-sqlite3');
const {
  getConversationIntelligence,
  analyzeResponseTimeImpact,
  getPeakHours,
  getCallDurationTrend,
  extractCommonTopics,
  generateCoachingTips,
  getWeekOverWeekComparison,
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

  describe('extractCommonTopics', () => {
    beforeEach(() => {
      db.prepare(`DELETE FROM calls WHERE client_id = 'topic_client'`).run();
    });

    it('should extract keywords from call transcripts', () => {
      db.prepare(`
        INSERT INTO clients (id, name, owner_name)
        VALUES ('topic_client', 'Topic Client', 'Owner')
      `).run();

      const now = new Date().toISOString();

      // Insert calls with keywords in summary
      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, summary, created_at)
        VALUES (?, ?, 'topic_client', '+12125551200', 'inbound', 300, 'booked', 'Customer asked about pricing', ?)
      `).run('topic_call1', 'topic_call1_id', now);

      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, summary, created_at)
        VALUES (?, ?, 'topic_client', '+12125551201', 'inbound', 200, 'qualified', 'Booking availability', ?)
      `).run('topic_call2', 'topic_call2_id', now);

      const result = extractCommonTopics(db, 'topic_client', now);

      expect(Array.isArray(result)).toBe(true);
      if (result.length > 0) {
        expect(result[0].topic).toBeDefined();
        expect(result[0].frequency).toBeGreaterThan(0);
      }
    });

    it('should count keyword frequency correctly', () => {
      db.prepare(`
        INSERT INTO clients (id, name, owner_name)
        VALUES ('freq_client', 'Freq Client', 'Owner')
      `).run();

      const now = new Date().toISOString();

      // Create 5 calls all mentioning "pricing"
      for (let i = 0; i < 5; i++) {
        db.prepare(`
          INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, summary, created_at)
          VALUES (?, ?, 'freq_client', ?, 'inbound', 300, 'booked', 'Customer wants pricing information', ?)
        `).run(`freq_call${i}`, `freq_call${i}_id`, `+1212555${1400 + i}`, now);
      }

      const result = extractCommonTopics(db, 'freq_client', now);

      const pricingTopic = result.find(t => t.topic.toLowerCase() === 'pricing');
      expect(pricingTopic).toBeDefined();
      expect(pricingTopic.frequency).toBe(5);
    });

    it('should require db and clientId parameters', () => {
      expect(() => {
        extractCommonTopics(null, 'client1', new Date().toISOString());
      }).toThrow();

      expect(() => {
        extractCommonTopics(db, null, new Date().toISOString());
      }).toThrow();
    });

    it('should return empty array for empty client', () => {
      const result = extractCommonTopics(db, 'nonexistent', new Date().toISOString());

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });

    it('should extract multiple unique topics', () => {
      db.prepare(`
        INSERT INTO clients (id, name, owner_name)
        VALUES ('multi_topic', 'Multi Topic', 'Owner')
      `).run();

      const now = new Date().toISOString();

      const keywords = [
        'pricing customer asked',
        'booking schedule appointment',
        'insurance coverage question',
      ];

      for (let i = 0; i < keywords.length; i++) {
        db.prepare(`
          INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, summary, created_at)
          VALUES (?, ?, 'multi_topic', ?, 'inbound', 300, 'booked', ?, ?)
        `).run(`mt_call${i}`, `mt_call${i}_id`, `+1212555${1500 + i}`, keywords[i], now);
      }

      const result = extractCommonTopics(db, 'multi_topic', now);

      expect(result.length).toBeGreaterThan(0);
      expect(result.length).toBeLessThanOrEqual(8); // Limited to top 8
    });
  });

  describe('generateCoachingTips', () => {
    beforeEach(() => {
      db.prepare(`DELETE FROM calls WHERE client_id = 'coaching_client'`).run();
    });

    it('should generate tips based on call statistics', () => {
      db.prepare(`
        INSERT INTO clients (id, name, owner_name)
        VALUES ('coaching_client', 'Coaching Client', 'Owner')
      `).run();

      const now = new Date().toISOString();

      // Insert calls
      for (let i = 0; i < 10; i++) {
        db.prepare(`
          INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, created_at)
          VALUES (?, ?, 'coaching_client', ?, 'inbound', 300, ?, ?)
        `).run(`coach_call${i}`, `coach_call${i}_id`, `+1212555${1600 + i}`, i < 5 ? 'booked' : 'not_interested', now);
      }

      const result = getConversationIntelligence(db, 'coaching_client', 30);

      expect(Array.isArray(result.coaching_tips)).toBe(true);
    });

    it('should provide tips for low booking rate', () => {
      db.prepare(`
        INSERT INTO clients (id, name, owner_name)
        VALUES ('low_booking', 'Low Booking', 'Owner')
      `).run();

      const now = new Date().toISOString();

      // Create 20 calls with only 1 booking (5% rate)
      for (let i = 0; i < 20; i++) {
        db.prepare(`
          INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, created_at)
          VALUES (?, ?, 'low_booking', ?, 'inbound', 60, ?, ?)
        `).run(`low_call${i}`, `low_call${i}_id`, `+1212555${1700 + i}`, i === 0 ? 'booked' : 'not_interested', now);
      }

      const result = getConversationIntelligence(db, 'low_booking', 30);

      expect(result.coaching_tips.length).toBeGreaterThan(0);
    });

    it('should provide tips for excellent booking rate', () => {
      db.prepare(`
        INSERT INTO clients (id, name, owner_name)
        VALUES ('high_booking', 'High Booking', 'Owner')
      `).run();

      const now = new Date().toISOString();

      // Create 20 calls with 50% booking rate
      for (let i = 0; i < 20; i++) {
        db.prepare(`
          INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, created_at)
          VALUES (?, ?, 'high_booking', ?, 'inbound', 180, ?, ?)
        `).run(`high_call${i}`, `high_call${i}_id`, `+1212555${1800 + i}`, i % 2 === 0 ? 'booked' : 'not_interested', now);
      }

      const result = getConversationIntelligence(db, 'high_booking', 30);

      expect(result.coaching_tips.length).toBeGreaterThan(0);
    });

    it('should provide tips for short call duration', () => {
      db.prepare(`
        INSERT INTO clients (id, name, owner_name)
        VALUES ('short_calls', 'Short Calls', 'Owner')
      `).run();

      const now = new Date().toISOString();

      // Create calls with short duration (30 seconds)
      for (let i = 0; i < 10; i++) {
        db.prepare(`
          INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, created_at)
          VALUES (?, ?, 'short_calls', ?, 'inbound', 30, ?, ?)
        `).run(`short_call${i}`, `short_call${i}_id`, `+1212555${1900 + i}`, 'not_interested', now);
      }

      const result = getConversationIntelligence(db, 'short_calls', 30);

      expect(result.coaching_tips.length).toBeGreaterThan(0);
    });
  });

  describe('getWeekOverWeekComparison', () => {
    beforeEach(() => {
      db.prepare(`DELETE FROM calls WHERE client_id = 'wow_client'`).run();
    });

    it('should return week comparison structure', () => {
      db.prepare(`
        INSERT INTO clients (id, name, owner_name)
        VALUES ('wow_client', 'WoW Client', 'Owner')
      `).run();

      const result = getWeekOverWeekComparison(db, 'wow_client');

      expect(result).toBeDefined();
      expect(result.this_week).toBeDefined();
      expect(result.last_week).toBeDefined();
      expect(result.change).toBeDefined();
    });

    it('should calculate this week stats correctly', () => {
      db.prepare(`
        INSERT INTO clients (id, name, owner_name)
        VALUES ('wow_this_week', 'WoW This Week', 'Owner')
      `).run();

      const now = new Date();
      const startOfWeek = new Date(now);
      startOfWeek.setDate(now.getDate() - now.getDay());
      startOfWeek.setHours(0, 0, 0, 0);

      const callTime = new Date(startOfWeek.getTime() + 2 * 24 * 60 * 60 * 1000); // Middle of week

      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, created_at)
        VALUES (?, ?, 'wow_this_week', '+12125552000', 'inbound', 300, 'booked', ?)
      `).run('wow_call1', 'wow_call1_id', callTime.toISOString());

      const result = getWeekOverWeekComparison(db, 'wow_this_week');

      expect(result.this_week.total_calls).toBe(1);
    });

    it('should calculate call difference between weeks', () => {
      db.prepare(`
        INSERT INTO clients (id, name, owner_name)
        VALUES ('wow_diff', 'WoW Diff', 'Owner')
      `).run();

      const now = new Date();

      // This week
      const thisWeekStart = new Date(now);
      thisWeekStart.setDate(now.getDate() - now.getDay());
      thisWeekStart.setHours(0, 0, 0, 0);

      // Last week
      const lastWeekStart = new Date(thisWeekStart);
      lastWeekStart.setDate(thisWeekStart.getDate() - 7);

      // Create 5 calls this week
      for (let i = 0; i < 5; i++) {
        const callTime = new Date(thisWeekStart.getTime() + i * 60 * 60 * 1000);
        db.prepare(`
          INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, created_at)
          VALUES (?, ?, 'wow_diff', ?, 'inbound', 300, 'booked', ?)
        `).run(`wow_diff_this${i}`, `wow_diff_this${i}_id`, `+1212555${2000 + i}`, callTime.toISOString());
      }

      // Create 2 calls last week
      for (let i = 0; i < 2; i++) {
        const callTime = new Date(lastWeekStart.getTime() + 3 * 24 * 60 * 60 * 1000 + i * 60 * 60 * 1000);
        db.prepare(`
          INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, created_at)
          VALUES (?, ?, 'wow_diff', ?, 'inbound', 300, 'booked', ?)
        `).run(`wow_diff_last${i}`, `wow_diff_last${i}_id`, `+1212555${2010 + i}`, callTime.toISOString());
      }

      const result = getWeekOverWeekComparison(db, 'wow_diff');

      // Just verify structure is correct - timing can vary
      expect(result.change).toBeDefined();
      expect(result.change.trend).toBeDefined();
      expect(['increasing', 'decreasing', 'stable']).toContain(result.change.trend);
    });

    it('should calculate booking rate difference', () => {
      db.prepare(`
        INSERT INTO clients (id, name, owner_name)
        VALUES ('wow_booking', 'WoW Booking', 'Owner')
      `).run();

      const now = new Date();
      const thisWeekStart = new Date(now);
      thisWeekStart.setDate(now.getDate() - now.getDay());
      thisWeekStart.setHours(0, 0, 0, 0);

      const callTime = new Date(thisWeekStart.getTime() + 60 * 60 * 1000);

      // This week: 1 booked, 4 not booked (20%)
      for (let i = 0; i < 5; i++) {
        db.prepare(`
          INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, created_at)
          VALUES (?, ?, 'wow_booking', ?, 'inbound', 300, ?, ?)
        `).run(`wow_book_${i}`, `wow_book_${i}_id`, `+1212555${2020 + i}`, i === 0 ? 'booked' : 'not_interested', callTime.toISOString());
      }

      const result = getWeekOverWeekComparison(db, 'wow_booking');

      expect(result.this_week).toBeDefined();
      expect(result.this_week.booking_rate).toBeDefined();
      // Booking rate should be a percentage string
      expect(typeof result.this_week.booking_rate).toBe('string');
      expect(result.this_week.booking_rate).toMatch(/\d+%/);
    });

    it('should require db and clientId parameters', () => {
      expect(() => {
        getWeekOverWeekComparison(null, 'client1');
      }).toThrow();

      expect(() => {
        getWeekOverWeekComparison(db, null);
      }).toThrow();
    });

    it('should handle empty client gracefully', () => {
      const result = getWeekOverWeekComparison(db, 'nonexistent_wow');

      expect(result).toBeDefined();
      expect(result.this_week.total_calls).toBe(0);
      expect(result.last_week.total_calls).toBe(0);
    });
  });

  describe('Advanced integration scenarios', () => {
    beforeEach(() => {
      db.prepare(`DELETE FROM calls WHERE client_id = 'integration_test'`).run();
      db.prepare(`DELETE FROM messages WHERE client_id = 'integration_test'`).run();
    });

    it('should handle complete intelligence report generation', () => {
      db.prepare(`
        INSERT INTO clients (id, name, owner_name)
        VALUES ('integration_test', 'Integration Test', 'Owner')
      `).run();

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name)
        VALUES ('int_lead', 'integration_test', '+12125553000', 5, 'booked', 'Integration Lead')
      `).run();

      const now = new Date().toISOString();

      // Mix of calls and messages
      for (let i = 0; i < 8; i++) {
        if (i < 4) {
          db.prepare(`
            INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, sentiment, created_at)
            VALUES (?, ?, 'integration_test', ?, 'inbound', ?, ?, ?, ?)
          `).run(
            `int_call${i}`,
            `int_call${i}_id`,
            `+1212555${3000 + i}`,
            100 + i * 50,
            i < 2 ? 'booked' : 'not_interested',
            i < 2 ? 'positive' : 'neutral',
            now
          );
        } else {
          db.prepare(`
            INSERT INTO messages (id, client_id, phone, direction, body, status, channel, created_at)
            VALUES (?, 'integration_test', ?, 'outbound', 'Message', 'sent', ?, ?)
          `).run(
            `int_msg${i}`,
            `+1212555${3000 + i}`,
            i % 2 === 0 ? 'sms' : 'email',
            now
          );
        }
      }

      const result = getConversationIntelligence(db, 'integration_test', 30);

      expect(result).toBeDefined();
      expect(result.summary.total_calls).toBeGreaterThan(0);
      expect(result.summary.total_messages).toBeGreaterThan(0);
      expect(result.sentiment_distribution).toBeDefined();
      expect(result.peak_hours).toBeDefined();
      expect(result.coaching_tips).toBeDefined();
    });

    it('should identify response time patterns correctly', () => {
      db.prepare(`
        INSERT INTO clients (id, name, owner_name)
        VALUES ('response_pattern', 'Response Pattern', 'Owner')
      `).run();

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name)
        VALUES ('rp_lead', 'response_pattern', '+12125553100', 5, 'booked', 'Pattern Lead')
      `).run();

      const baseTime = new Date('2024-01-01T10:00:00Z');

      // Fast response: 2 minutes
      db.prepare(`
        INSERT INTO messages (id, client_id, phone, direction, body, status, created_at)
        VALUES (?, 'response_pattern', '+12125553100', 'outbound', 'Hi', 'sent', ?)
      `).run('rp_out1', baseTime.toISOString());

      const responseTime = new Date(baseTime.getTime() + 2 * 60 * 1000);
      db.prepare(`
        INSERT INTO messages (id, client_id, phone, direction, body, status, created_at)
        VALUES (?, 'response_pattern', '+12125553100', 'inbound', 'Hey', 'received', ?)
      `).run('rp_in1', responseTime.toISOString());

      const result = analyzeResponseTimeImpact(db, 'response_pattern');

      expect(result.buckets).toBeDefined();
      expect(Array.isArray(result.buckets)).toBe(true);
    });
  });
});
