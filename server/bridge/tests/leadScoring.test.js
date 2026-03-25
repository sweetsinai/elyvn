const Database = require('better-sqlite3');
const { predictLeadScore, getConversionAnalytics, batchScoreLeads, getLeadScoringReport } = require('../utils/leadScoring');
const { runMigrations } = require('../utils/migrations');

describe('Lead Scoring Module', () => {
  let db;

  beforeAll(() => {
    db = new Database(':memory:');
    runMigrations(db);

    // Insert test client
    db.prepare(`
      INSERT INTO clients (id, name, owner_name, avg_ticket)
      VALUES ('client1', 'Test Business', 'John Owner', 5000)
    `).run();
  });

  afterAll(() => {
    db.close();
  });

  describe('predictLeadScore', () => {
    it('should return score 0-100 with valid factors for a new lead', () => {
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name)
        VALUES ('lead1', 'client1', '+12125551234', 0, 'new', 'Test Lead')
      `).run();

      const result = predictLeadScore(db, 'lead1', 'client1');

      expect(result).toBeDefined();
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(result.factors).toBeDefined();
      expect(result.factors.responsiveness).toBeDefined();
      expect(result.factors.engagement).toBeDefined();
      expect(result.factors.intent).toBeDefined();
      expect(result.factors.recency).toBeDefined();
      expect(result.factors.channelDiversity).toBeDefined();
      expect(result.insight).toBeDefined();
      expect(result.recommended_action).toBeDefined();
    });

    it('should return 0 score for missing lead', () => {
      const result = predictLeadScore(db, 'nonexistent', 'client1');

      expect(result.score).toBe(0);
      expect(result.insight).toBe('Lead not found');
    });

    it('should score leads with more interactions higher', () => {
      // Create two leads
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name)
        VALUES ('lead2', 'client1', '+12125551235', 0, 'new', 'Low Activity Lead')
      `).run();

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name)
        VALUES ('lead3', 'client1', '+12125551236', 0, 'new', 'High Activity Lead')
      `).run();

      const now = new Date().toISOString();

      // Low activity: 1 call
      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, score, created_at)
        VALUES ('call1', 'call1_id', 'client1', '+12125551235', 'inbound', 120, 'not_interested', 3, ?)
      `).run(now);

      // High activity: 5 calls + 3 messages
      for (let i = 0; i < 5; i++) {
        db.prepare(`
          INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, score, created_at)
          VALUES (?, ?, 'client1', '+12125551236', 'inbound', 300, 'qualified', 8, ?)
        `).run(`call_high_${i}`, `call_high_${i}_id`, now);
      }

      for (let i = 0; i < 3; i++) {
        db.prepare(`
          INSERT INTO messages (id, client_id, phone, direction, body, status, created_at)
          VALUES (?, 'client1', '+12125551236', 'inbound', 'Message', 'received', ?)
        `).run(`msg_${i}`, now);
      }

      const lowScore = predictLeadScore(db, 'lead2', 'client1');
      const highScore = predictLeadScore(db, 'lead3', 'client1');

      expect(highScore.score).toBeGreaterThan(lowScore.score);
      expect(highScore.details.totalInteractions).toBe(8);
      expect(lowScore.details.totalInteractions).toBe(1);
    });

    it('should score recently active leads higher than stale ones', () => {
      const now = new Date().toISOString();
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name)
        VALUES ('lead_recent', 'client1', '+12125551237', 0, 'new', 'Recent Lead')
      `).run();

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name)
        VALUES ('lead_stale', 'client1', '+12125551238', 0, 'new', 'Stale Lead')
      `).run();

      // Recent: call today
      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, score, created_at)
        VALUES ('call_recent', 'call_recent_id', 'client1', '+12125551237', 'inbound', 300, 'qualified', 8, ?)
      `).run(now);

      // Stale: call 30 days ago
      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, score, created_at)
        VALUES ('call_stale', 'call_stale_id', 'client1', '+12125551238', 'inbound', 300, 'qualified', 8, ?)
      `).run(thirtyDaysAgo);

      const recentScore = predictLeadScore(db, 'lead_recent', 'client1');
      const staleScore = predictLeadScore(db, 'lead_stale', 'client1');

      expect(recentScore.score).toBeGreaterThan(staleScore.score);
      expect(recentScore.factors.recency).toBeGreaterThan(staleScore.factors.recency);
    });

    it('should provide insight based on score range', () => {
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name)
        VALUES ('lead_insight', 'client1', '+12125551239', 5, 'new', 'Insight Test')
      `).run();

      const result = predictLeadScore(db, 'lead_insight', 'client1');

      expect(result.insight).toBeDefined();
      expect(result.insight.length).toBeGreaterThan(0);
    });
  });

  describe('batchScoreLeads', () => {
    it('should return array sorted by score descending', () => {
      db.prepare(`DELETE FROM leads WHERE client_id = 'client1'`).run();
      db.prepare(`DELETE FROM calls WHERE client_id = 'client1'`).run();

      const now = new Date().toISOString();

      // Create leads with different scores
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name)
        VALUES ('batch_lead1', 'client1', '+12125551240', 3, 'new', 'Low Score')
      `).run();

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name)
        VALUES ('batch_lead2', 'client1', '+12125551241', 8, 'new', 'High Score')
      `).run();

      // Add interactions for high score lead
      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, score, created_at)
        VALUES ('batch_call1', 'batch_call1_id', 'client1', '+12125551241', 'inbound', 300, 'qualified', 8, ?)
      `).run(now);

      const result = batchScoreLeads(db, 'client1');

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(2);
      expect(result[0].predictive_score).toBeGreaterThanOrEqual(result[1].predictive_score);
      expect(result[0]).toHaveProperty('leadId');
      expect(result[0]).toHaveProperty('phone');
      expect(result[0]).toHaveProperty('predictive_score');
      expect(result[0]).toHaveProperty('insight');
      expect(result[0]).toHaveProperty('recommended_action');
    });

    it('should exclude lost and booked leads from batch scoring', () => {
      db.prepare(`DELETE FROM leads WHERE client_id = 'client1'`).run();

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name)
        VALUES ('active_lead', 'client1', '+12125551242', 5, 'warm', 'Active')
      `).run();

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name, calcom_booking_id)
        VALUES ('booked_lead', 'client1', '+12125551243', 9, 'booked', 'Booked', 'booking123')
      `).run();

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name)
        VALUES ('lost_lead', 'client1', '+12125551244', 2, 'lost', 'Lost')
      `).run();

      const result = batchScoreLeads(db, 'client1');

      const activeIds = result.map(l => l.leadId);
      expect(activeIds).toContain('active_lead');
      expect(activeIds).not.toContain('lost_lead');
    });

    it('should return empty array for non-existent client', () => {
      const result = batchScoreLeads(db, 'nonexistent_client');

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });
  });

  describe('getConversionAnalytics', () => {
    it('should return valid structure with correct metrics', () => {
      db.prepare(`DELETE FROM leads WHERE client_id = 'client1'`).run();
      db.prepare(`DELETE FROM calls WHERE client_id = 'client1'`).run();
      db.prepare(`DELETE FROM messages WHERE client_id = 'client1'`).run();

      const now = new Date().toISOString();

      // Create 10 leads, 3 converted
      for (let i = 0; i < 10; i++) {
        const stage = i < 3 ? 'booked' : 'new';
        const phone = `+1212555${1250 + i}`;
        db.prepare(`
          INSERT INTO leads (id, client_id, phone, score, stage, name)
          VALUES (?, 'client1', ?, ?, ?, ?)
        `).run(`conv_lead${i}`, phone, 5, stage, `Lead ${i}`);

        // Add some interactions
        db.prepare(`
          INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, score, created_at)
          VALUES (?, ?, 'client1', ?, 'inbound', 300, 'qualified', 8, ?)
        `).run(`conv_call${i}`, `conv_call${i}_id`, phone, now);

        if (i < 3) {
          db.prepare(`
            INSERT INTO messages (id, client_id, phone, direction, body, status, created_at)
            VALUES (?, 'client1', ?, 'inbound', 'Message', 'received', ?)
          `).run(`conv_msg${i}`, phone, now);
        }
      }

      const result = getConversionAnalytics(db, 'client1');

      expect(result).toBeDefined();
      expect(result.conversion_rate).toBeGreaterThan(0);
      expect(result.conversion_rate).toBeLessThanOrEqual(100);
      expect(result.avg_touches_to_convert).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(result.best_contact_times)).toBe(true);
      expect(Array.isArray(result.top_sources)).toBe(true);
    });

    it('should return zero metrics for empty client', () => {
      const result = getConversionAnalytics(db, 'empty_client');

      expect(result.conversion_rate).toBe(0);
      expect(result.avg_touches_to_convert).toBe(0);
      expect(result.best_contact_times.length).toBe(0);
      expect(result.top_sources.length).toBe(0);
    });

    it('should calculate conversion rate correctly', () => {
      db.prepare(`DELETE FROM leads WHERE client_id = 'client1'`).run();

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name)
        VALUES ('rate1', 'client1', '+12125551300', 5, 'booked', 'Converted')
      `).run();

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name)
        VALUES ('rate2', 'client1', '+12125551301', 3, 'new', 'Not Converted')
      `).run();

      const result = getConversionAnalytics(db, 'client1');

      expect(result.conversion_rate).toBe(50);
    });
  });

  describe('getLeadScoringReport', () => {
    it('should return comprehensive report for a lead', () => {
      db.prepare(`DELETE FROM leads WHERE client_id = 'client1'`).run();
      db.prepare(`DELETE FROM calls WHERE client_id = 'client1'`).run();

      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name, source)
        VALUES ('report_lead', 'client1', '+12125551302', 7, 'warm', 'Report Test', 'form')
      `).run();

      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, score, created_at)
        VALUES ('report_call', 'report_call_id', 'client1', '+12125551302', 'inbound', 300, 'qualified', 8, ?)
      `).run(now);

      const result = getLeadScoringReport(db, 'report_lead', 'client1');

      expect(result).toBeDefined();
      expect(result.lead).toBeDefined();
      expect(result.score).toBeDefined();
      expect(result.factors).toBeDefined();
      expect(result.factorExplanation).toBeDefined();
      expect(result.insight).toBeDefined();
      expect(result.recommended_action).toBeDefined();
      expect(result.details).toBeDefined();
      expect(result.benchmarks).toBeDefined();
    });

    it('should return null for non-existent lead', () => {
      const result = getLeadScoringReport(db, 'nonexistent', 'client1');

      expect(result).toBeNull();
    });
  });
});
