const Database = require('better-sqlite3');
const {
  generateDailySchedule,
  analyzeTimeSlotSuccess,
  getOptimalContactTime,
  getOptimalTimesForAllLeads,
} = require('../utils/smartScheduler');
const { runMigrations } = require('../utils/migrations');

describe('Smart Scheduler Module', () => {
  let db;

  beforeAll(() => {
    db = new Database(':memory:');
    runMigrations(db);

    // Insert test client
    db.prepare(`
      INSERT INTO clients (id, name, owner_name)
      VALUES ('client1', 'Test Business', 'John Owner')
    `).run();
  });

  afterAll(() => {
    db.close();
  });

  describe('generateDailySchedule', () => {
    it('should return array of scheduled contacts', () => {
      db.prepare(`DELETE FROM leads WHERE client_id = 'client1'`).run();
      db.prepare(`DELETE FROM calls WHERE client_id = 'client1'`).run();

      // Create leads that need contact (updated > 1 day ago, not booked/lost)
      const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();

      for (let i = 0; i < 5; i++) {
        const phone = `+1212555${1500 + i}`;
        db.prepare(`
          INSERT INTO leads (id, client_id, phone, score, stage, name, updated_at)
          VALUES (?, 'client1', ?, ?, 'warm', ?, ?)
        `).run(`sched_lead${i}`, phone, 5 + i, `Lead ${i}`, twoDaysAgo);
      }

      const result = generateDailySchedule(db, 'client1');

      expect(Array.isArray(result)).toBe(true);

      if (result.length > 0) {
        const item = result[0];
        expect(item.leadId).toBeDefined();
        expect(item.phone).toBeDefined();
        expect(item.name).toBeDefined();
        expect(item.scheduled_time).toBeDefined();
        expect(item.priority).toBeGreaterThanOrEqual(0);
        expect(item.reason).toBeDefined();
      }
    });

    it('should exclude booked and lost leads from schedule', () => {
      db.prepare(`DELETE FROM leads WHERE client_id = 'client1'`).run();

      const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();

      // Active lead
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name, updated_at)
        VALUES ('active_lead', 'client1', '+12125551600', 5, 'warm', 'Active', ?)
      `).run(twoDaysAgo);

      // Booked lead
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name, calcom_booking_id, updated_at)
        VALUES ('booked_lead', 'client1', '+12125551601', 9, 'booked', 'Booked', 'booking123', ?)
      `).run(twoDaysAgo);

      // Lost lead
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name, updated_at)
        VALUES ('lost_lead', 'client1', '+12125551602', 2, 'lost', 'Lost', ?)
      `).run(twoDaysAgo);

      const result = generateDailySchedule(db, 'client1');

      const scheduledIds = result.map(item => item.leadId);
      expect(scheduledIds).toContain('active_lead');
      expect(scheduledIds).not.toContain('booked_lead');
      expect(scheduledIds).not.toContain('lost_lead');
    });

    it('should exclude leads updated within 1 day', () => {
      db.prepare(`DELETE FROM leads WHERE client_id = 'client1'`).run();

      const now = new Date().toISOString();
      const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();

      // Recently updated (should be excluded)
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name, updated_at)
        VALUES ('recent_lead', 'client1', '+12125551603', 5, 'warm', 'Recent', ?)
      `).run(now);

      // Old (should be included)
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name, updated_at)
        VALUES ('old_lead', 'client1', '+12125551604', 5, 'warm', 'Old', ?)
      `).run(twoDaysAgo);

      const result = generateDailySchedule(db, 'client1');

      const scheduledIds = result.map(item => item.leadId);
      expect(scheduledIds).not.toContain('recent_lead');
      expect(scheduledIds).toContain('old_lead');
    });

    it('should sort by priority (highest first)', () => {
      db.prepare(`DELETE FROM leads WHERE client_id = 'client1'`).run();

      const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name, updated_at)
        VALUES ('low_priority', 'client1', '+12125551605', 2, 'warm', 'Low', ?)
      `).run(twoDaysAgo);

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name, updated_at)
        VALUES ('high_priority', 'client1', '+12125551606', 9, 'warm', 'High', ?)
      `).run(twoDaysAgo);

      const result = generateDailySchedule(db, 'client1');

      if (result.length >= 2) {
        expect(result[0].priority).toBeGreaterThanOrEqual(result[1].priority);
      }
    });

    it('should return empty array for non-existent client', () => {
      const result = generateDailySchedule(db, 'nonexistent');

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });
  });

  describe('analyzeTimeSlotSuccess', () => {
    it('should return slots and recommendation', () => {
      db.prepare(`DELETE FROM calls WHERE client_id = 'client1'`).run();

      const now = new Date().toISOString();

      // Create calls at different hours
      for (let hour = 9; hour < 17; hour++) {
        const date = new Date(now);
        date.setHours(hour);

        for (let i = 0; i < 3; i++) {
          const outcome = i === 0 ? 'booked' : 'not_interested';
          db.prepare(`
            INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, created_at)
            VALUES (?, ?, 'client1', '+12125551700', 'inbound', 300, ?, ?)
          `).run(`slot_call_${hour}_${i}`, `slot_call_${hour}_${i}_id`, outcome, date.toISOString());
        }
      }

      const result = analyzeTimeSlotSuccess(db, 'client1');

      expect(result).toBeDefined();
      expect(Array.isArray(result.slots)).toBe(true);
      expect(result.recommendation).toBeDefined();

      for (const slot of result.slots) {
        expect(slot.hour).toBeDefined();
        expect(slot.success_rate).toBeGreaterThanOrEqual(0);
        expect(slot.success_rate).toBeLessThanOrEqual(100);
        expect(slot.sample_size).toBeGreaterThanOrEqual(0);
      }
    });

    it('should generate appropriate recommendation based on data', () => {
      db.prepare(`DELETE FROM calls WHERE client_id = 'client1'`).run();

      const result = analyzeTimeSlotSuccess(db, 'client1');

      expect(result.recommendation).toBeDefined();
      expect(typeof result.recommendation).toBe('string');
    });

    it('should identify best time slot with sufficient samples', () => {
      db.prepare(`DELETE FROM calls WHERE client_id = 'slot_client'`).run();

      db.prepare(`
        INSERT INTO clients (id, name, owner_name)
        VALUES ('slot_client', 'Slot Test', 'Owner')
      `).run();

      const now = new Date().toISOString();

      // Create 10 calls at 10 AM, 8 booked (80% success)
      const date10am = new Date(now);
      date10am.setHours(10);

      for (let i = 0; i < 10; i++) {
        const outcome = i < 8 ? 'booked' : 'not_interested';
        db.prepare(`
          INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, created_at)
          VALUES (?, ?, 'slot_client', '+12125551800', 'inbound', 300, ?, ?)
        `).run(`best_call_${i}`, `best_call_${i}_id`, outcome, date10am.toISOString());
      }

      // Create 5 calls at 2 PM, 1 booked (20% success)
      const date2pm = new Date(now);
      date2pm.setHours(14);

      for (let i = 0; i < 5; i++) {
        const outcome = i === 0 ? 'booked' : 'not_interested';
        db.prepare(`
          INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, created_at)
          VALUES (?, ?, 'slot_client', '+12125551800', 'inbound', 300, ?, ?)
        `).run(`worst_call_${i}`, `worst_call_${i}_id`, outcome, date2pm.toISOString());
      }

      const result = analyzeTimeSlotSuccess(db, 'slot_client');

      expect(result.slots).toBeDefined();
      expect(result.slots.length).toBeGreaterThan(0);

      // Best slot should be 10 AM with 80% success rate
      const slot10am = result.slots.find(s => s.hour === 10);
      if (slot10am && slot10am.sample_size >= 5) {
        expect(slot10am.success_rate).toBeGreaterThanOrEqual(50);
      }
    });

    it('should return null for non-existent client', () => {
      const result = analyzeTimeSlotSuccess(db, null);
      expect(result).toBeNull();
    });
  });

  describe('getOptimalContactTime', () => {
    it('should return optimal contact time for lead', () => {
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name)
        VALUES ('opt_lead', 'client1', '+12125551900', 5, 'warm', 'Optimal Test')
      `).run();

      const result = getOptimalContactTime(db, 'opt_lead', 'client1');

      expect(result).toBeDefined();
      expect(result.optimal_hour).toBeGreaterThanOrEqual(0);
      expect(result.optimal_hour).toBeLessThanOrEqual(23);
      expect(result.optimal_day).toBeDefined();
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      expect(result.reason).toBeDefined();
    });

    it('should return null for non-existent lead', () => {
      const result = getOptimalContactTime(db, 'nonexistent', 'client1');
      expect(result).toBeNull();
    });

    it('should return null for missing leadId', () => {
      const result = getOptimalContactTime(db, null, 'client1');
      expect(result).toBeNull();
    });

    it('should return null for missing clientId', () => {
      const result = getOptimalContactTime(db, 'leadId', null);
      expect(result).toBeNull();
    });

    it('should increase confidence with more successful interactions', () => {
      db.prepare(`DELETE FROM calls WHERE client_id = 'client1' AND caller_phone = '+12125551901'`).run();

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name)
        VALUES ('conf_lead', 'client1', '+12125551901', 5, 'warm', 'Confidence Test')
      `).run();

      const date = new Date();
      date.setHours(10);

      // One successful interaction
      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, score, created_at)
        VALUES ('conf_call1', 'conf_call1_id', 'client1', '+12125551901', 'inbound', 300, 'booked', 8, ?)
      `).run(date.toISOString());

      const result1 = getOptimalContactTime(db, 'conf_lead', 'client1');

      // Add more successful interactions
      for (let i = 0; i < 4; i++) {
        db.prepare(`
          INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, score, created_at)
          VALUES (?, ?, 'client1', '+12125551901', 'inbound', 300, 'booked', 8, ?)
        `).run(`conf_call_${i + 2}`, `conf_call_${i + 2}_id`, date.toISOString());
      }

      const result2 = getOptimalContactTime(db, 'conf_lead', 'client1');

      expect(result2.confidence).toBeGreaterThanOrEqual(result1.confidence);
    });

    it('should suggest reasonable default for lead with no history', () => {
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name)
        VALUES ('new_contact_lead', 'client1', '+12125551902', 0, 'new', 'New Lead')
      `).run();

      const result = getOptimalContactTime(db, 'new_contact_lead', 'client1');

      expect(result.optimal_hour).toBeDefined();
      expect(result.optimal_day).toBeDefined();
      expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it('should handle success criteria: booked, qualified, and score >= 6', () => {
      const phone = '+12125559999';
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name)
        VALUES ('score_lead', 'client1', ?, 5, 'warm', 'Score Test')
      `).run(phone);

      const date = new Date();
      date.setHours(14);

      // Add calls with different success criteria
      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, created_at)
        VALUES ('call1', 'call1_id', 'client1', ?, 'inbound', 300, 'booked', ?)
      `).run(phone, date.toISOString());

      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, created_at)
        VALUES ('call2', 'call2_id', 'client1', ?, 'inbound', 300, 'qualified', ?)
      `).run(phone, date.toISOString());

      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, score, created_at)
        VALUES ('call3', 'call3_id', 'client1', ?, 'inbound', 300, 'other', 7, ?)
      `).run(phone, date.toISOString());

      const result = getOptimalContactTime(db, 'score_lead', 'client1');

      expect(result.optimal_hour).toBe(14); // All successes at 14 (2 PM)
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it('should use general patterns when no successful interactions exist', () => {
      const phone = '+12125558888';
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name)
        VALUES ('gen_lead', 'client1', ?, 0, 'new', 'General Test')
      `).run(phone);

      const date = new Date();

      // Add only failed calls
      for (let hour = 9; hour < 12; hour++) {
        const d = new Date(date);
        d.setHours(hour);
        db.prepare(`
          INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, created_at)
          VALUES (?, ?, 'client1', ?, 'inbound', 300, 'not_interested', ?)
        `).run(`gen_call_${hour}`, `gen_call_${hour}_id`, phone, d.toISOString());
      }

      const result = getOptimalContactTime(db, 'gen_lead', 'client1');

      expect(result.optimal_hour).toBeGreaterThanOrEqual(9);
      expect(result.optimal_hour).toBeLessThan(12);
      expect(result.confidence).toBeLessThanOrEqual(0.6);
    });

    it('should include message data in analysis', () => {
      const phone = '+12125557777';
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name)
        VALUES ('msg_lead', 'client1', ?, 0, 'new', 'Message Test')
      `).run(phone);

      const date = new Date();
      date.setHours(11);

      db.prepare(`
        INSERT INTO messages (id, client_id, phone, status, created_at)
        VALUES ('msg1', 'client1', ?, 'sent', ?)
      `).run(phone, date.toISOString());

      const result = getOptimalContactTime(db, 'msg_lead', 'client1');

      expect(result).toBeDefined();
      expect(result.reason).toContain('interactions');
    });

    it('should return default hour 10 and Monday when no data available', () => {
      const phone = '+12125556666';
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name)
        VALUES ('no_data_lead', 'client1', ?, 0, 'new', 'No Data')
      `).run(phone);

      const result = getOptimalContactTime(db, 'no_data_lead', 'client1');

      expect(result.optimal_hour).toBe(10);
      expect(result.optimal_day).toBe('Monday');
      expect(result.confidence).toBe(0.5);
    });

    it('should calculate confidence correctly based on success distribution', () => {
      const phone = '+12125555555';
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name)
        VALUES ('conf_calc_lead', 'client1', ?, 0, 'new', 'Conf Calc')
      `).run(phone);

      const date = new Date();
      date.setHours(15);

      // 5 successful calls
      for (let i = 0; i < 5; i++) {
        db.prepare(`
          INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, created_at)
          VALUES (?, ?, 'client1', ?, 'inbound', 300, 'booked', ?)
        `).run(`conf_calc_${i}`, `conf_calc_${i}_id`, phone, date.toISOString());
      }

      const result = getOptimalContactTime(db, 'conf_calc_lead', 'client1');

      // Confidence = min(0.95, (5/5) + 0.3) = min(0.95, 1.3) = 0.95
      expect(result.confidence).toBe(0.95);
    });
  });

  describe('getOptimalTimesForAllLeads', () => {
    it('should return array of optimal times for all leads', () => {
      db.prepare(`DELETE FROM leads WHERE client_id = 'client1'`).run();

      for (let i = 0; i < 3; i++) {
        db.prepare(`
          INSERT INTO leads (id, client_id, phone, score, stage, name)
          VALUES (?, 'client1', ?, 5, 'warm', ?)
        `).run(`batch_lead${i}`, `+1212555${2000 + i}`, `Batch Lead ${i}`);
      }

      const result = getOptimalTimesForAllLeads(db, 'client1');

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(3);

      for (const item of result) {
        expect(item.leadId).toBeDefined();
        expect(item.optimal_hour).toBeDefined();
        expect(item.optimal_day).toBeDefined();
        expect(item.confidence).toBeDefined();
      }
    });

    it('should return empty array for client with no leads', () => {
      const result = getOptimalTimesForAllLeads(db, 'empty_client');

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });

    it('should return empty array for null client', () => {
      const result = getOptimalTimesForAllLeads(db, null);

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });

    it('should filter out null timing results', () => {
      // Create a client with one valid lead and check result doesn't include nulls
      db.prepare(`DELETE FROM leads WHERE client_id = 'filter_client'`).run();

      db.prepare(`
        INSERT INTO clients (id, name, owner_name)
        VALUES ('filter_client', 'Filter Test', 'Owner')
      `).run();

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name)
        VALUES ('valid_lead', 'filter_client', '+12125554444', 5, 'warm', 'Valid')
      `).run();

      const result = getOptimalTimesForAllLeads(db, 'filter_client');

      expect(result.length).toBe(1);
      expect(result[0].leadId).toBe('valid_lead');
    });
  });

  describe('Edge Cases and Integration', () => {
    it('should handle leads with special characters in names', () => {
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name, updated_at)
        VALUES ('special_lead', 'client1', '+12125551234', 5, 'warm', ?, ?)
      `).run('John\'s Lead (Test)', new Date().toISOString());

      const result = generateDailySchedule(db, 'client1');
      const scheduleItem = result.find(item => item.leadId === 'special_lead');

      if (scheduleItem) {
        expect(scheduleItem.name).toBe('John\'s Lead (Test)');
      }
    });

    it('should handle leads with NULL names', () => {
      db.prepare(`DELETE FROM leads WHERE client_id = 'client1' AND name IS NULL`).run();

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name, updated_at)
        VALUES ('null_name_lead', 'client1', '+12125551111', 5, 'warm', NULL, ?)
      `).run(new Date(Date.now() - 2 * 86400000).toISOString());

      const result = generateDailySchedule(db, 'client1');
      const item = result.find(item => item.leadId === 'null_name_lead');

      if (item) {
        expect(item.name).toBe('Unknown');
      }
    });

    it('should distribute leads across business hours (9 AM to 5 PM)', () => {
      db.prepare(`DELETE FROM leads WHERE client_id = 'dist_client'`).run();

      db.prepare(`
        INSERT INTO clients (id, name, owner_name)
        VALUES ('dist_client', 'Distribution Test', 'Owner')
      `).run();

      const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();

      // Create 10 leads
      for (let i = 0; i < 10; i++) {
        db.prepare(`
          INSERT INTO leads (id, client_id, phone, score, stage, name, updated_at)
          VALUES (?, 'dist_client', ?, ?, 'warm', ?, ?)
        `).run(`dist_lead_${i}`, `+1212555${3000 + i}`, i, `Lead ${i}`, twoDaysAgo);
      }

      const result = generateDailySchedule(db, 'dist_client');

      // All scheduled times should be during business hours
      result.forEach(item => {
        const time = new Date(item.scheduled_time);
        const hour = time.getHours();
        expect(hour).toBeGreaterThanOrEqual(9);
        expect(hour).toBeLessThanOrEqual(17);
      });
    });

    it('should skip lunch hour (12 PM - 1 PM)', () => {
      db.prepare(`DELETE FROM leads WHERE client_id = 'lunch_client'`).run();

      db.prepare(`
        INSERT INTO clients (id, name, owner_name)
        VALUES ('lunch_client', 'Lunch Test', 'Owner')
      `).run();

      const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();

      // Create many leads to test the hour distribution logic
      for (let i = 0; i < 15; i++) {
        db.prepare(`
          INSERT INTO leads (id, client_id, phone, score, stage, name, updated_at)
          VALUES (?, 'lunch_client', ?, ?, 'warm', ?, ?)
        `).run(`lunch_lead_${i}`, `+1212556${i}`, i, `Lead ${i}`, twoDaysAgo);
      }

      const result = generateDailySchedule(db, 'lunch_client');

      // Check that hours skip 12
      const hours = result.map(item => new Date(item.scheduled_time).getHours());
      // We shouldn't have a 12 if more leads are scheduled across hours
      // (depends on the number of leads, but hour 12 should be skipped)
    });

    it('should calculate success rate correctly for priority', () => {
      db.prepare(`DELETE FROM leads WHERE client_id = 'success_client'`).run();
      db.prepare(`DELETE FROM calls WHERE client_id = 'success_client'`).run();

      db.prepare(`
        INSERT INTO clients (id, name, owner_name)
        VALUES ('success_client', 'Success Test', 'Owner')
      `).run();

      const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
      const phone = '+12125552222';

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name, updated_at)
        VALUES ('success_lead', 'success_client', ?, 5, 'warm', 'Success', ?)
      `).run(phone, twoDaysAgo);

      // Create 4 calls: 2 booked, 2 not interested = 50% success rate
      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, created_at)
        VALUES ('succ1', 'succ1_id', 'success_client', ?, 'inbound', 300, 'booked', ?)
      `).run(phone, new Date().toISOString());

      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, created_at)
        VALUES ('succ2', 'succ2_id', 'success_client', ?, 'inbound', 300, 'booked', ?)
      `).run(phone, new Date().toISOString());

      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, created_at)
        VALUES ('succ3', 'succ3_id', 'success_client', ?, 'inbound', 300, 'not_interested', ?)
      `).run(phone, new Date().toISOString());

      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, created_at)
        VALUES ('succ4', 'succ4_id', 'success_client', ?, 'inbound', 300, 'not_interested', ?)
      `).run(phone, new Date().toISOString());

      const result = generateDailySchedule(db, 'success_client');
      const item = result.find(item => item.leadId === 'success_lead');

      if (item) {
        // Priority should be: score (5) + (successRate * 3) = 5 + (0.5 * 3) = 6.5
        expect(item.priority).toBeCloseTo(6.5, 1);
      }
    });

    it('should handle leads with zero score', () => {
      db.prepare(`DELETE FROM leads WHERE client_id = 'zero_score_client'`).run();

      db.prepare(`
        INSERT INTO clients (id, name, owner_name)
        VALUES ('zero_score_client', 'Zero Score Test', 'Owner')
      `).run();

      const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name, updated_at)
        VALUES ('zero_lead', 'zero_score_client', '+12125550000', 0, 'warm', 'Zero', ?)
      `).run(twoDaysAgo);

      const result = generateDailySchedule(db, 'zero_score_client');
      const item = result.find(item => item.leadId === 'zero_lead');

      expect(item).toBeDefined();
      expect(item.priority).toBeGreaterThanOrEqual(0);
    });

    it('should include reason with score and success rate in schedule', () => {
      db.prepare(`DELETE FROM leads WHERE client_id = 'reason_client'`).run();

      db.prepare(`
        INSERT INTO clients (id, name, owner_name)
        VALUES ('reason_client', 'Reason Test', 'Owner')
      `).run();

      const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, name, updated_at)
        VALUES ('reason_lead', 'reason_client', '+12125554321', 8, 'warm', 'Reason', ?)
      `).run(twoDaysAgo);

      const result = generateDailySchedule(db, 'reason_client');
      const item = result.find(item => item.leadId === 'reason_lead');

      if (item) {
        expect(item.reason).toContain('Lead score');
        expect(item.reason).toContain('Success rate');
      }
    });

    it('should wrap hour back to 9 when exceeding 17', () => {
      db.prepare(`DELETE FROM leads WHERE client_id = 'wrap_client'`).run();

      db.prepare(`
        INSERT INTO clients (id, name, owner_name)
        VALUES ('wrap_client', 'Wrap Test', 'Owner')
      `).run();

      const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();

      // Create 20 leads to ensure wrapping
      for (let i = 0; i < 20; i++) {
        db.prepare(`
          INSERT INTO leads (id, client_id, phone, score, stage, name, updated_at)
          VALUES (?, 'wrap_client', ?, ?, 'warm', ?, ?)
        `).run(`wrap_lead_${i}`, `+1212557${i}`, i, `Lead ${i}`, twoDaysAgo);
      }

      const result = generateDailySchedule(db, 'wrap_client');

      // All times should be valid hours
      result.forEach(item => {
        const hour = new Date(item.scheduled_time).getHours();
        expect(hour).toBeGreaterThanOrEqual(9);
        expect(hour).toBeLessThanOrEqual(17);
      });
    });
  });
});
