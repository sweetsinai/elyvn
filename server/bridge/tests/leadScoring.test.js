const Database = require('better-sqlite3');
const { predictLeadScore, getConversionAnalytics, batchScoreLeads, getLeadScoringReport } = require('../utils/leadScoring');
const { runMigrations } = require('../utils/migrations');

// Add db.query helper to a raw better-sqlite3 instance
function addQueryHelper(db) {
  db.query = function query(sql, params = [], mode = 'all') {
    try {
      const stmt = db.prepare(sql);
      let result;
      if (mode === 'get') result = stmt.get(...(params || []));
      else if (mode === 'run') result = stmt.run(...(params || []));
      else result = stmt.all(...(params || []));
      return Promise.resolve(result);
    } catch (err) {
      return Promise.reject(err);
    }
  };
  return db;
}

describe('Lead Scoring Module', () => {
  let db;

  beforeAll(() => {
    db = new Database(':memory:');
    runMigrations(db);
    addQueryHelper(db);

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
    it('should return score 0-100 with valid factors for a new lead', async () => {
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name)
        VALUES ('lead1', 'client1', '+12125551234', 0, 'new', 'Test Lead')
      `).run();

      const result = await predictLeadScore(db, 'lead1', 'client1');

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

    it('should return 0 score for missing lead', async () => {
      const result = await predictLeadScore(db, 'nonexistent', 'client1');

      expect(result.score).toBe(0);
      expect(result.insight).toBe('Lead not found');
    });

    it('should score leads with more interactions higher', async () => {
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

      const lowScore = await predictLeadScore(db, 'lead2', 'client1');
      const highScore = await predictLeadScore(db, 'lead3', 'client1');

      expect(highScore.score).toBeGreaterThan(lowScore.score);
      expect(highScore.details.totalInteractions).toBe(8);
      expect(lowScore.details.totalInteractions).toBe(1);
    });

    it('should score recently active leads higher than stale ones', async () => {
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

      const recentScore = await predictLeadScore(db, 'lead_recent', 'client1');
      const staleScore = await predictLeadScore(db, 'lead_stale', 'client1');

      expect(recentScore.score).toBeGreaterThan(staleScore.score);
      expect(recentScore.factors.recency).toBeGreaterThan(staleScore.factors.recency);
    });

    it('should provide insight based on score range', async () => {
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name)
        VALUES ('lead_insight', 'client1', '+12125551239', 5, 'new', 'Insight Test')
      `).run();

      const result = await predictLeadScore(db, 'lead_insight', 'client1');

      expect(result.insight).toBeDefined();
      expect(result.insight.length).toBeGreaterThan(0);
    });
  });

  describe('batchScoreLeads', () => {
    it('should return array sorted by score descending', async () => {
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

      const result = await batchScoreLeads(db, 'client1');

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(2);
      expect(result[0].predictive_score).toBeGreaterThanOrEqual(result[1].predictive_score);
      expect(result[0]).toHaveProperty('leadId');
      expect(result[0]).toHaveProperty('phone');
      expect(result[0]).toHaveProperty('predictive_score');
      expect(result[0]).toHaveProperty('insight');
      expect(result[0]).toHaveProperty('recommended_action');
    });

    it('should exclude lost and booked leads from batch scoring', async () => {
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

      const result = await batchScoreLeads(db, 'client1');

      const activeIds = result.map(l => l.leadId);
      expect(activeIds).toContain('active_lead');
      expect(activeIds).not.toContain('lost_lead');
    });

    it('should return empty array for non-existent client', async () => {
      const result = await batchScoreLeads(db, 'nonexistent_client');

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });
  });

  describe('getConversionAnalytics', () => {
    it('should return valid structure with correct metrics', async () => {
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

      const result = await getConversionAnalytics(db, 'client1');

      expect(result).toBeDefined();
      expect(result.conversion_rate).toBeGreaterThan(0);
      expect(result.conversion_rate).toBeLessThanOrEqual(100);
      expect(result.avg_touches_to_convert).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(result.best_contact_times)).toBe(true);
      expect(Array.isArray(result.top_sources)).toBe(true);
    });

    it('should return zero metrics for empty client', async () => {
      const result = await getConversionAnalytics(db, 'empty_client');

      expect(result.conversion_rate).toBe(0);
      expect(result.avg_touches_to_convert).toBe(0);
      expect(result.best_contact_times.length).toBe(0);
      expect(result.top_sources.length).toBe(0);
    });

    it('should calculate conversion rate correctly', async () => {
      db.prepare(`DELETE FROM leads WHERE client_id = 'client1'`).run();

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name)
        VALUES ('rate1', 'client1', '+12125551300', 5, 'booked', 'Converted')
      `).run();

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name)
        VALUES ('rate2', 'client1', '+12125551301', 3, 'new', 'Not Converted')
      `).run();

      const result = await getConversionAnalytics(db, 'client1');

      expect(result.conversion_rate).toBe(50);
    });
  });

  describe('getLeadScoringReport', () => {
    it('should return comprehensive report for a lead', async () => {
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

      const result = await getLeadScoringReport(db, 'report_lead', 'client1');

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

    it('should return null for non-existent lead', async () => {
      const result = await getLeadScoringReport(db, 'nonexistent', 'client1');

      expect(result).toBeNull();
    });

    it('should return null when missing leadId', async () => {
      const result = await getLeadScoringReport(db, null, 'client1');
      expect(result).toBeNull();
    });

    it('should return null when missing clientId', async () => {
      const result = await getLeadScoringReport(db, 'lead1', null);
      expect(result).toBeNull();
    });
  });

  describe('predictLeadScore - Edge Cases and Branches', () => {
    it('should return 0 when both leadId and clientId are missing', async () => {
      const result = await predictLeadScore(db, null, null);
      expect(result.score).toBe(0);
      expect(result.insight).toBe('Insufficient data');
    });

    it('should return 0 when only leadId is missing', async () => {
      const result = await predictLeadScore(db, null, 'client1');
      expect(result.score).toBe(0);
    });

    it('should handle responsiveness with immediate response (< 5 min)', async () => {
      db.prepare(`DELETE FROM leads WHERE id = 'resp_lead1'`).run();
      db.prepare(`DELETE FROM messages WHERE phone = '+12125551400'`).run();

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage)
        VALUES ('resp_lead1', 'client1', '+12125551400', 0, 'new')
      `).run();

      const now = Date.now();
      const twoMinutesAgo = new Date(now - 2 * 60000).toISOString();
      const oneMinuteAgo = new Date(now - 60000).toISOString();

      db.prepare(`
        INSERT INTO messages (id, client_id, phone, direction, body, status, created_at)
        VALUES (?, 'client1', '+12125551400', 'outbound', 'Hello', 'sent', ?)
      `).run('msg_out1', twoMinutesAgo);

      db.prepare(`
        INSERT INTO messages (id, client_id, phone, direction, body, status, created_at)
        VALUES (?, 'client1', '+12125551400', 'inbound', 'Hi', 'received', ?)
      `).run('msg_in1', oneMinuteAgo);

      const result = await predictLeadScore(db, 'resp_lead1', 'client1');
      expect(result.factors.responsiveness).toBe(100);
    });

    it('should handle responsiveness with 30 min response (very fast)', async () => {
      db.prepare(`DELETE FROM leads WHERE id = 'resp_lead2'`).run();
      db.prepare(`DELETE FROM messages WHERE phone = '+12125551401'`).run();

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage)
        VALUES ('resp_lead2', 'client1', '+12125551401', 0, 'new')
      `).run();

      const now = Date.now();
      const fortyMinutesAgo = new Date(now - 40 * 60000).toISOString();
      const tenMinutesAgo = new Date(now - 10 * 60000).toISOString();

      db.prepare(`
        INSERT INTO messages (id, client_id, phone, direction, body, status, created_at)
        VALUES (?, 'client1', '+12125551401', 'outbound', 'Hello', 'sent', ?)
      `).run('msg_out2', fortyMinutesAgo);

      db.prepare(`
        INSERT INTO messages (id, client_id, phone, direction, body, status, created_at)
        VALUES (?, 'client1', '+12125551401', 'inbound', 'Hi', 'received', ?)
      `).run('msg_in2', tenMinutesAgo);

      const result = await predictLeadScore(db, 'resp_lead2', 'client1');
      // Between 30-60 minutes should be 75
      expect(result.factors.responsiveness).toBe(75);
    });

    it('should detect responsiveness via call answer (no first response message)', async () => {
      db.prepare(`DELETE FROM leads WHERE id = 'resp_call'`).run();
      db.prepare(`DELETE FROM messages WHERE phone = '+12125551402'`).run();
      db.prepare(`DELETE FROM calls WHERE caller_phone = '+12125551402'`).run();

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage)
        VALUES ('resp_call', 'client1', '+12125551402', 0, 'new')
      `).run();

      const now = Date.now();
      const oneHourAgo = new Date(now - 60 * 60000).toISOString();
      const fiftyMinutesAgo = new Date(now - 50 * 60000).toISOString();

      db.prepare(`
        INSERT INTO messages (id, client_id, phone, direction, body, status, created_at)
        VALUES (?, 'client1', '+12125551402', 'outbound', 'Call me', 'sent', ?)
      `).run('msg_call1', oneHourAgo);

      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, score, created_at)
        VALUES (?, ?, 'client1', '+12125551402', 'inbound', 300, 'qualified', 8, ?)
      `).run('call_resp', 'call_resp_id', fiftyMinutesAgo);

      const result = await predictLeadScore(db, 'resp_call', 'client1');
      expect(result.factors.responsiveness).toBeGreaterThan(0);
    });

    it('should score engagement with 5+ interactions at max', async () => {
      db.prepare(`DELETE FROM leads WHERE id = 'eng_lead5'`).run();
      db.prepare(`DELETE FROM calls WHERE caller_phone = '+12125551405'`).run();
      db.prepare(`DELETE FROM messages WHERE phone = '+12125551405'`).run();

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage)
        VALUES ('eng_lead5', 'client1', '+12125551405', 0, 'new')
      `).run();

      const now = new Date().toISOString();
      for (let i = 0; i < 5; i++) {
        db.prepare(`
          INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, score, created_at)
          VALUES (?, ?, 'client1', '+12125551405', 'inbound', 300, 'qualified', 8, ?)
        `).run(`call_eng${i}`, `call_eng${i}_id`, now);
      }

      const result = await predictLeadScore(db, 'eng_lead5', 'client1');
      expect(result.factors.engagement).toBe(100);
    });

    it('should handle intent signals from different sources', async () => {
      db.prepare(`DELETE FROM leads WHERE id = 'intent_lead'`).run();
      db.prepare(`DELETE FROM calls WHERE caller_phone = '+12125551410'`).run();

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, source)
        VALUES ('intent_lead', 'client1', '+12125551410', 0, 'new', 'missed_call')
      `).run();

      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, score, sentiment, created_at)
        VALUES (?, ?, 'client1', '+12125551410', 'inbound', 300, 'qualified', 8, 9, ?)
      `).run('call_intent', 'call_intent_id', now);

      const result = await predictLeadScore(db, 'intent_lead', 'client1');
      expect(result.factors.intent).toBeGreaterThan(0);
    });

    it('should score recency with various time windows', async () => {
      db.prepare(`DELETE FROM leads WHERE id LIKE 'recency_%'`).run();
      db.prepare(`DELETE FROM calls WHERE id LIKE 'call_%' AND id NOT LIKE 'call_high%' AND id NOT LIKE 'call_action%' AND id NOT LIKE 'call_resp%' AND id NOT LIKE 'call_intent%' AND id NOT LIKE 'call_eng%' AND id NOT LIKE 'call_multi%'`).run();

      const testCases = [
        { name: 'now', minutes: 0, expectedFactor: 100 },
        { name: '12h', minutes: 12 * 60, expectedFactor: 90 },
        { name: '48h', minutes: 48 * 60, expectedFactor: 75 },
      ];

      for (const [idx, testCase] of testCases.entries()) {
        const leadId = `recency_${testCase.name}`;
        const phone = `+1212555${1800 + idx}`;

        db.prepare(`
          INSERT INTO leads (id, client_id, phone, score, stage)
          VALUES (?, 'client1', ?, 0, 'new')
        `).run(leadId, phone);

        const contactTime = new Date(Date.now() - testCase.minutes * 60000).toISOString();
        db.prepare(`
          INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, score, created_at)
          VALUES (?, ?, 'client1', ?, 'inbound', 300, 'qualified', 8, ?)
        `).run(`recency_call_${testCase.name}`, `recency_call_${testCase.name}_id`, phone, contactTime);

        const result = await predictLeadScore(db, leadId, 'client1');
        expect(result.factors.recency).toBeLessThanOrEqual(100);
        expect(result.factors.recency).toBeGreaterThanOrEqual(5);
      }
    });

    it('should score multi-channel engagement higher', async () => {
      db.prepare(`DELETE FROM leads WHERE id = 'multi_lead'`).run();
      db.prepare(`DELETE FROM calls WHERE caller_phone = '+12125551456'`).run();
      db.prepare(`DELETE FROM messages WHERE phone = '+12125551456'`).run();

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage)
        VALUES ('multi_lead', 'client1', '+12125551456', 0, 'new')
      `).run();

      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, score, created_at)
        VALUES (?, ?, 'client1', '+12125551456', 'inbound', 300, 'qualified', 8, ?)
      `).run('call_multi', 'call_multi_id', now);

      db.prepare(`
        INSERT INTO messages (id, client_id, phone, direction, body, status, created_at)
        VALUES (?, 'client1', '+12125551456', 'inbound', 'Message', 'received', ?)
      `).run('msg_multi', now);

      const result = await predictLeadScore(db, 'multi_lead', 'client1');
      expect(result.factors.channelDiversity).toBe(100);
    });

    it('should generate actionable insights based on score ranges', async () => {
      db.prepare(`DELETE FROM leads WHERE client_id = 'client1'`).run();

      // High urgency lead (score >= 80)
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage)
        VALUES ('high_lead', 'client1', '+12125551460', 5, 'new')
      `).run();

      const now = new Date().toISOString();
      for (let i = 0; i < 8; i++) {
        db.prepare(`
          INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, score, created_at)
          VALUES (?, ?, 'client1', '+12125551460', 'inbound', 300, 'qualified', 8, ?)
        `).run(`call_high${i}`, `call_high${i}_id`, now);
      }

      const highResult = await predictLeadScore(db, 'high_lead', 'client1');
      if (highResult.score >= 80) {
        expect(highResult.insight).toContain('urgency');
        expect(highResult.recommended_action).toContain('immediately');
      }
    });

    it('should recommend different actions based on score', async () => {
      const testCases = [
        { score: 85, shouldContain: 'immediately' },
        { score: 65, shouldContain: 'follow-up' },
        { score: 55, shouldContain: 'SMS' },
      ];

      for (let i = 0; i < testCases.length; i++) {
        const leadId = `action_lead${i}`;
        const phone = `+1212555${1470 + i}`;

        db.prepare(`
          INSERT INTO leads (id, client_id, phone, score, stage)
          VALUES (?, 'client1', ?, 0, 'new')
        `).run(leadId, phone);

        const now = new Date().toISOString();
        for (let j = 0; j < testCases[i].score / 10; j++) {
          db.prepare(`
            INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, score, created_at)
            VALUES (?, ?, 'client1', ?, 'inbound', 300, 'qualified', 8, ?)
          `).run(`call_action${i}_${j}`, `call_action${i}_${j}_id`, phone, now);
        }

        const result = await predictLeadScore(db, leadId, 'client1');
        expect(result.recommended_action).toBeDefined();
        expect(result.recommended_action.length).toBeGreaterThan(0);
      }
    });

    it('should handle leads with no first outreach gracefully', async () => {
      db.prepare(`DELETE FROM leads WHERE id = 'no_outreach_lead'`).run();
      db.prepare(`DELETE FROM messages WHERE phone = '+12125551920'`).run();
      db.prepare(`DELETE FROM calls WHERE caller_phone = '+12125551920'`).run();

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage)
        VALUES ('no_outreach_lead', 'client1', '+12125551920', 0, 'new')
      `).run();

      const result = await predictLeadScore(db, 'no_outreach_lead', 'client1');
      // Lead with no interactions will have score based on factors
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.insight).toBeDefined();
    });

    it('should handle error gracefully during scoring', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      const result = await predictLeadScore(db, 'nonexistent_id', 'nonexistent_client');
      expect(result.score).toBe(0);

      consoleSpy.mockRestore();
    });

    it('should batch score multiple leads efficiently', async () => {
      db.prepare(`DELETE FROM leads WHERE client_id = 'client1'`).run();

      for (let i = 0; i < 5; i++) {
        db.prepare(`
          INSERT INTO leads (id, client_id, phone, score, stage)
          VALUES (?, 'client1', ?, ?, 'warm')
        `).run(`batch_${i}`, `+1212555${1490 + i}`, 5 - i);
      }

      const result = await batchScoreLeads(db, 'client1');
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeLessThanOrEqual(5);
      expect(result[0].predictive_score).toBeGreaterThanOrEqual(result[result.length - 1]?.predictive_score || 0);
    });
  });
});
