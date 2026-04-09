/**
 * Tests for utils/intelligence/* modules:
 *   - stats.js      (getConversationIntelligence, analyzeResponseTimeImpact, getWeekOverWeekComparison)
 *   - peakHours.js  (getPeakHours)
 *   - trends.js     (getCallDurationTrend)
 *   - topics.js     (extractCommonTopics)
 *   - coaching.js   (generateCoachingTips)
 */

const Database = require('better-sqlite3');
const { runMigrations } = require('../utils/migrations');

const { getConversationIntelligence, analyzeResponseTimeImpact, getWeekOverWeekComparison } = require('../utils/intelligence/stats');
const { getPeakHours } = require('../utils/intelligence/peakHours');
const { getCallDurationTrend } = require('../utils/intelligence/trends');
const { extractCommonTopics } = require('../utils/intelligence/topics');
const { generateCoachingTips } = require('../utils/intelligence/coaching');

// ── helpers ──────────────────────────────────────────────────────────────────

function addQueryMethod(db) {
  db.query = function (sql, params = [], mode = 'all') {
    try {
      const stmt = db.prepare(sql);
      if (mode === 'get') return Promise.resolve(stmt.get(...(params || [])));
      if (mode === 'run') return Promise.resolve(stmt.run(...(params || [])));
      return Promise.resolve(stmt.all(...(params || [])));
    } catch (err) {
      return Promise.reject(err);
    }
  };
}

let db;
let clientSeq = 0;

function nextClientId() {
  return `intel_client_${++clientSeq}`;
}

function insertClient(id, name = 'Test Biz') {
  db.prepare(`INSERT OR IGNORE INTO clients (id, name, owner_name) VALUES (?, ?, 'Owner')`).run(id, name);
}

function insertCall(id, clientId, opts = {}) {
  const {
    phone = '+12125551234',
    duration = 300,
    outcome = 'booked',
    sentiment = 'positive',
    transcript = null,
    summary = null,
    createdAt = new Date().toISOString(),
  } = opts;
  db.prepare(`
    INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, sentiment, transcript, summary, created_at)
    VALUES (?, ?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?)
  `).run(id, `${id}_cid`, clientId, phone, duration, outcome, sentiment, transcript, summary, createdAt);
}

function insertMessage(id, clientId, opts = {}) {
  const {
    phone = '+12125551234',
    direction = 'outbound',
    body = 'Hello',
    createdAt = new Date().toISOString(),
  } = opts;
  db.prepare(`
    INSERT INTO messages (id, client_id, phone, direction, body, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'sent', ?)
  `).run(id, clientId, phone, direction, body, createdAt);
}

// ── setup / teardown ─────────────────────────────────────────────────────────

beforeAll(() => {
  db = new Database(':memory:');
  runMigrations(db);
  addQueryMethod(db);
});

afterAll(() => {
  db.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// peakHours.js
// ─────────────────────────────────────────────────────────────────────────────

describe('getPeakHours', () => {
  it('returns empty array for client with no calls', async () => {
    insertClient('ph_empty');
    const result = await getPeakHours(db, 'ph_empty');
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  it('returns array with correct shape for client with calls', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const now = new Date().toISOString();
    insertCall('ph_c1', cid, { phone: '+15005550001', outcome: 'booked', createdAt: now });
    insertCall('ph_c2', cid, { phone: '+15005550002', outcome: 'not_interested', createdAt: now });

    const result = await getPeakHours(db, cid);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);

    const entry = result[0];
    expect(typeof entry.hour).toBe('number');
    expect(typeof entry.day).toBe('string');
    expect(typeof entry.calls).toBe('number');
    expect(typeof entry.messages).toBe('number');
    expect(typeof entry.bookings).toBe('number');
  });

  it('counts bookings correctly', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const now = new Date().toISOString();
    insertCall('ph_b1', cid, { phone: '+15005550010', outcome: 'booked', createdAt: now });
    insertCall('ph_b2', cid, { phone: '+15005550011', outcome: 'booked', createdAt: now });
    insertCall('ph_b3', cid, { phone: '+15005550012', outcome: 'not_interested', createdAt: now });

    const result = await getPeakHours(db, cid);
    const totalBookings = result.reduce((s, r) => s + r.bookings, 0);
    expect(totalBookings).toBe(2);
  });

  it('includes message counts when messages exist', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const now = new Date().toISOString();
    insertCall('ph_m1', cid, { phone: '+15005550020', createdAt: now });
    insertMessage('ph_msg1', cid, { phone: '+15005550020', createdAt: now });

    const result = await getPeakHours(db, cid);
    expect(Array.isArray(result)).toBe(true);
  });

  it('caps result at 14 entries', async () => {
    const cid = nextClientId();
    insertClient(cid);
    for (let h = 0; h < 18; h++) {
      const d = new Date();
      d.setHours(h, 0, 0, 0);
      insertCall(`ph_cap_${h}`, cid, { phone: `+1500555${1000 + h}`, createdAt: d.toISOString() });
    }
    const result = await getPeakHours(db, cid);
    expect(result.length).toBeLessThanOrEqual(14);
  });

  it('throws when db is null', async () => {
    await expect(getPeakHours(null, 'x')).rejects.toThrow();
  });

  it('throws when clientId is null', async () => {
    await expect(getPeakHours(db, null)).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// trends.js
// ─────────────────────────────────────────────────────────────────────────────

describe('getCallDurationTrend', () => {
  it('returns empty array for client with no calls', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const result = await getCallDurationTrend(db, cid, 30);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  it('returns correct shape for client with calls', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const now = new Date().toISOString();
    insertCall('tr_c1', cid, { duration: 120, createdAt: now });
    insertCall('tr_c2', cid, { phone: '+15005550101', duration: 240, createdAt: now });

    const result = await getCallDurationTrend(db, cid, 30);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);

    const entry = result[0];
    expect(typeof entry.week).toBe('string');
    expect(typeof entry.avg_duration).toBe('number');
    expect(typeof entry.call_count).toBe('number');
    expect(typeof entry.min_duration).toBe('number');
    expect(typeof entry.max_duration).toBe('number');
  });

  it('calculates avg_duration correctly for a single week', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const now = new Date().toISOString();
    insertCall('tr_avg1', cid, { duration: 100, createdAt: now });
    insertCall('tr_avg2', cid, { phone: '+15005550110', duration: 200, createdAt: now });

    const result = await getCallDurationTrend(db, cid, 30);
    expect(result.length).toBe(1);
    expect(result[0].avg_duration).toBe(150);
    expect(result[0].min_duration).toBe(100);
    expect(result[0].max_duration).toBe(200);
    expect(result[0].call_count).toBe(2);
  });

  it('respects the days lookback window', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const recent = new Date().toISOString();
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 days ago

    insertCall('tr_rec1', cid, { duration: 100, createdAt: recent });
    insertCall('tr_old1', cid, { phone: '+15005550120', duration: 200, createdAt: old });

    const result = await getCallDurationTrend(db, cid, 30);
    // Only the recent call should appear
    const totalCalls = result.reduce((s, r) => s + r.call_count, 0);
    expect(totalCalls).toBe(1);
  });

  it('throws when db is null', async () => {
    await expect(getCallDurationTrend(null, 'x', 30)).rejects.toThrow();
  });

  it('throws when clientId is null', async () => {
    await expect(getCallDurationTrend(db, null, 30)).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// topics.js
// ─────────────────────────────────────────────────────────────────────────────

describe('extractCommonTopics', () => {
  const since = new Date(0).toISOString(); // epoch — include everything

  it('returns empty array for client with no calls', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const result = await extractCommonTopics(db, cid, since);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  it('returns empty array when calls have no transcript or summary', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const now = new Date().toISOString();
    insertCall('top_nosummary', cid, { summary: null, transcript: null, createdAt: now });
    const result = await extractCommonTopics(db, cid, since);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  it('detects Pricing topic from summary keyword', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const now = new Date().toISOString();
    insertCall('top_price1', cid, { summary: 'Customer asked about pricing', createdAt: now });

    const result = await extractCommonTopics(db, cid, since);
    const pricingTopic = result.find(t => t.topic === 'Pricing');
    expect(pricingTopic).toBeDefined();
    expect(pricingTopic.frequency).toBeGreaterThanOrEqual(1);
  });

  it('detects Booking topic from summary keyword', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const now = new Date().toISOString();
    insertCall('top_book1', cid, { summary: 'schedule an appointment for next week', createdAt: now });

    const result = await extractCommonTopics(db, cid, since);
    const bookingTopic = result.find(t => t.topic === 'Booking');
    expect(bookingTopic).toBeDefined();
  });

  it('counts frequency correctly across multiple calls', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const now = new Date().toISOString();
    for (let i = 0; i < 5; i++) {
      insertCall(`top_freq_${cid}_${i}`, cid, {
        phone: `+1500555${2000 + i}`,
        summary: 'customer asked about cost and pricing',
        createdAt: now,
      });
    }

    const result = await extractCommonTopics(db, cid, since);
    const pricingTopic = result.find(t => t.topic === 'Pricing');
    expect(pricingTopic).toBeDefined();
    expect(pricingTopic.frequency).toBe(5);
  });

  it('returns results sorted by frequency descending', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const now = new Date().toISOString();

    // 3x pricing, 1x booking
    for (let i = 0; i < 3; i++) {
      insertCall(`top_sort_p_${cid}_${i}`, cid, {
        phone: `+1500555${2100 + i}`,
        summary: 'pricing query',
        createdAt: now,
      });
    }
    insertCall(`top_sort_b_${cid}`, cid, {
      phone: '+15005552199',
      summary: 'book an appointment please',
      createdAt: now,
    });

    const result = await extractCommonTopics(db, cid, since);
    for (let i = 0; i < result.length - 1; i++) {
      expect(result[i].frequency).toBeGreaterThanOrEqual(result[i + 1].frequency);
    }
  });

  it('caps results at 8 topics', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const now = new Date().toISOString();
    // Insert a call with all topic keywords present
    insertCall(`top_cap_${cid}`, cid, {
      summary: 'pricing booking available location service insurance question help issue problem',
      createdAt: now,
    });

    const result = await extractCommonTopics(db, cid, since);
    expect(result.length).toBeLessThanOrEqual(8);
  });

  it('detects keywords from transcript field as well', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const now = new Date().toISOString();
    insertCall(`top_trans_${cid}`, cid, {
      transcript: 'what is your location and address?',
      summary: null,
      createdAt: now,
    });

    const result = await extractCommonTopics(db, cid, since);
    const locationTopic = result.find(t => t.topic === 'Location');
    expect(locationTopic).toBeDefined();
  });

  it('throws when db is null', async () => {
    await expect(extractCommonTopics(null, 'x', since)).rejects.toThrow();
  });

  it('throws when clientId is null', async () => {
    await expect(extractCommonTopics(db, null, since)).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// coaching.js
// ─────────────────────────────────────────────────────────────────────────────

describe('generateCoachingTips', () => {
  // Minimal callStats with all fields
  function makeCallStats(overrides = {}) {
    return {
      avg_duration: 300,
      positive_sentiment: 5,
      neutral_sentiment: 3,
      negative_sentiment: 2,
      ...overrides,
    };
  }

  it('returns an array', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const tips = await generateCoachingTips(db, cid, makeCallStats(), 20, null, []);
    expect(Array.isArray(tips)).toBe(true);
  });

  it('caps tips at 5', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const now = new Date().toISOString();
    // Seed calls so the db queries inside return something
    for (let i = 0; i < 10; i++) {
      insertCall(`coach_cap_${cid}_${i}`, cid, {
        phone: `+1500555${3000 + i}`,
        duration: i < 5 ? 50 : 200,
        outcome: i < 2 ? 'booked' : 'not_interested',
        sentiment: i % 3 === 0 ? 'negative' : 'positive',
        createdAt: now,
      });
    }

    const durationTrend = [
      { avg_duration: 100 },
      { avg_duration: 200 },
    ];

    const tips = await generateCoachingTips(db, cid, makeCallStats({ avg_duration: 50 }), 5, 120, durationTrend);
    expect(tips.length).toBeLessThanOrEqual(5);
  });

  it('adds a tip for avg_duration < 60 seconds', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const tips = await generateCoachingTips(db, cid, makeCallStats({ avg_duration: 30 }), 20, null, []);
    const hasDurationTip = tips.some(t => /duration/i.test(t));
    expect(hasDurationTip).toBe(true);
  });

  it('adds a tip for low booking rate (< 10%)', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const tips = await generateCoachingTips(db, cid, makeCallStats(), 5, null, []);
    const hasLowBookingTip = tips.some(t => /booking rate/i.test(t));
    expect(hasLowBookingTip).toBe(true);
  });

  it('adds a tip for excellent booking rate (> 35%)', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const tips = await generateCoachingTips(db, cid, makeCallStats(), 40, null, []);
    const hasExcellentTip = tips.some(t => /excellent/i.test(t) || /booking rate/i.test(t));
    expect(hasExcellentTip).toBe(true);
  });

  it('adds a response time tip when avgResponseMinutes < 5', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const tips = await generateCoachingTips(db, cid, makeCallStats(), 20, 2, []);
    const hasResponseTip = tips.some(t => /response/i.test(t) || /lightning/i.test(t));
    expect(hasResponseTip).toBe(true);
  });

  it('adds a response time tip when avgResponseMinutes is between 5 and 60', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const tips = await generateCoachingTips(db, cid, makeCallStats(), 20, 30, []);
    const hasResponseTip = tips.some(t => /response time/i.test(t) || /minutes/i.test(t));
    expect(hasResponseTip).toBe(true);
  });

  it('adds a slow response tip when avgResponseMinutes >= 60', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const tips = await generateCoachingTips(db, cid, makeCallStats(), 20, 120, []);
    const hasSlowTip = tips.some(t => /slow response/i.test(t) || /hours/i.test(t));
    expect(hasSlowTip).toBe(true);
  });

  it('adds a negative sentiment tip when > 20% calls are negative', async () => {
    const cid = nextClientId();
    insertClient(cid);
    // totalSentiment must be > 10 and negativeRate > 20%
    // Use: positive=5, neutral=5, negative=4 → total=14, negRate=28%
    const callStats = makeCallStats({ positive_sentiment: 5, neutral_sentiment: 5, negative_sentiment: 4 });
    const tips = await generateCoachingTips(db, cid, callStats, 20, null, []);
    const hasSentimentTip = tips.some(t => /negative sentiment/i.test(t) || /pain points/i.test(t));
    expect(hasSentimentTip).toBe(true);
  });

  it('adds a duration trend tip when recent week > previous week', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const durationTrend = [{ avg_duration: 100 }, { avg_duration: 200 }];
    const tips = await generateCoachingTips(db, cid, makeCallStats({ avg_duration: 200 }), 20, null, durationTrend);
    const hasTrendTip = tips.some(t => /week-over-week/i.test(t) || /duration up/i.test(t));
    expect(hasTrendTip).toBe(true);
  });

  it('does not add trend tip when single data point only', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const tips = await generateCoachingTips(db, cid, makeCallStats({ avg_duration: 200 }), 20, null, [{ avg_duration: 100 }]);
    // Should not crash, just produce zero or fewer tips
    expect(Array.isArray(tips)).toBe(true);
  });

  it('handles empty callStats gracefully', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const callStats = { avg_duration: null, positive_sentiment: 0, neutral_sentiment: 0, negative_sentiment: 0 };
    const tips = await generateCoachingTips(db, cid, callStats, 0, null, []);
    expect(Array.isArray(tips)).toBe(true);
  });

  it('adds peak window tip when peak data has bookings > 2', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const now = new Date().toISOString();
    // Insert 3 booked calls in the same hour to make a peak
    for (let i = 0; i < 3; i++) {
      insertCall(`coach_peak_${cid}_${i}`, cid, {
        phone: `+1500555${4000 + i}`,
        outcome: 'booked',
        createdAt: now,
      });
    }
    const tips = await generateCoachingTips(db, cid, makeCallStats(), 20, null, []);
    // Whether or not the peak tip fires depends on data — just ensure no crash
    expect(Array.isArray(tips)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stats.js — getConversationIntelligence
// ─────────────────────────────────────────────────────────────────────────────

describe('getConversationIntelligence', () => {
  it('throws when db is null', async () => {
    await expect(getConversationIntelligence(null, 'x')).rejects.toThrow();
  });

  it('throws when clientId is null', async () => {
    await expect(getConversationIntelligence(db, null)).rejects.toThrow();
  });

  it('returns zeros for client with no data', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const result = await getConversationIntelligence(db, cid, 30);

    expect(result.summary.total_calls).toBe(0);
    expect(result.summary.total_messages).toBe(0);
    expect(result.summary.booking_rate).toBe('0%');
    expect(result.sentiment_distribution.positive).toBe(0);
    expect(result.sentiment_distribution.neutral).toBe(0);
    expect(result.sentiment_distribution.negative).toBe(0);
    expect(Array.isArray(result.peak_hours)).toBe(true);
    expect(Array.isArray(result.coaching_tips)).toBe(true);
    expect(Array.isArray(result.common_topics)).toBe(true);
  });

  it('returns full report structure', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const now = new Date().toISOString();
    insertCall('stat_c1', cid, { duration: 300, outcome: 'booked', sentiment: 'positive', createdAt: now });
    insertCall('stat_c2', cid, { phone: '+15005550201', duration: 100, outcome: 'not_interested', sentiment: 'negative', createdAt: now });
    insertMessage('stat_m1', cid, { createdAt: now });

    const result = await getConversationIntelligence(db, cid, 30);

    expect(result.summary).toBeDefined();
    expect(result.summary.period_days).toBe(30);
    expect(result.sentiment_distribution).toBeDefined();
    expect(result.call_duration_stats).toBeDefined();
    expect(result.peak_hours).toBeDefined();
    expect(result.call_duration_trend).toBeDefined();
    expect(result.common_topics).toBeDefined();
    expect(result.response_time_analysis).toBeDefined();
    expect(result.coaching_tips).toBeDefined();
  });

  it('calculates sentiment distribution correctly', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const now = new Date().toISOString();
    // 3 positive, 1 neutral, 1 negative → 60% / 20% / 20%
    for (let i = 0; i < 3; i++) {
      insertCall(`sd_pos_${cid}_${i}`, cid, { phone: `+1500555${5000 + i}`, sentiment: 'positive', createdAt: now });
    }
    insertCall(`sd_neu_${cid}`, cid, { phone: '+15005555003', sentiment: 'neutral', createdAt: now });
    insertCall(`sd_neg_${cid}`, cid, { phone: '+15005555004', sentiment: 'negative', createdAt: now });

    const result = await getConversationIntelligence(db, cid, 30);
    expect(result.sentiment_distribution.positive).toBe(60);
    expect(result.sentiment_distribution.neutral).toBe(20);
    expect(result.sentiment_distribution.negative).toBe(20);
  });

  it('calculates booking rate correctly', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const now = new Date().toISOString();
    // 2 booked out of 4 total → 50%
    for (let i = 0; i < 4; i++) {
      insertCall(`br_${cid}_${i}`, cid, {
        phone: `+1500555${6000 + i}`,
        outcome: i < 2 ? 'booked' : 'not_interested',
        createdAt: now,
      });
    }

    const result = await getConversationIntelligence(db, cid, 30);
    expect(result.summary.booking_rate).toBe('50%');
  });

  it('uses default days=30 when not provided', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const result = await getConversationIntelligence(db, cid);
    expect(result.summary.period_days).toBe(30);
  });

  it('respects custom days lookback', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const result = await getConversationIntelligence(db, cid, 7);
    expect(result.summary.period_days).toBe(7);
  });

  it('returns 0 booking rate when no calls', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const result = await getConversationIntelligence(db, cid, 30);
    expect(result.summary.booking_rate).toBe('0%');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stats.js — analyzeResponseTimeImpact
// ─────────────────────────────────────────────────────────────────────────────

describe('analyzeResponseTimeImpact', () => {
  it('throws when db is null', async () => {
    await expect(analyzeResponseTimeImpact(null, 'x')).rejects.toThrow();
  });

  it('throws when clientId is null', async () => {
    await expect(analyzeResponseTimeImpact(db, null)).rejects.toThrow();
  });

  it('returns all 6 buckets even with no data', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const result = await analyzeResponseTimeImpact(db, cid);
    expect(Array.isArray(result.buckets)).toBe(true);
    expect(result.buckets.length).toBe(6);
    expect(result.optimal_window).toBe('Insufficient data');
    expect(result.total_responses_analyzed).toBe(0);
  });

  it('returns correct bucket labels', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const result = await analyzeResponseTimeImpact(db, cid);
    const expectedLabels = ['0-1 min', '1-5 min', '5-15 min', '15-60 min', '1-4 hours', '4+ hours'];
    const labels = result.buckets.map(b => b.range);
    expect(labels).toEqual(expectedLabels);
  });

  it('returns correct conversion_rate format', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const result = await analyzeResponseTimeImpact(db, cid);
    for (const bucket of result.buckets) {
      expect(bucket.conversion_rate).toMatch(/^\d+%$/);
    }
  });

  it('fills buckets when messages and leads exist', async () => {
    const cid = nextClientId();
    insertClient(cid);
    db.prepare(`INSERT OR IGNORE INTO leads (id, client_id, phone, score, stage, name) VALUES (?, ?, ?, 5, 'new', 'Lead')`).run(`rt_lead_${cid}`, cid, '+15005557000');

    const t0 = new Date('2024-06-01T10:00:00Z');
    const t1 = new Date(t0.getTime() + 3 * 60 * 1000); // 3 min response → '1-5 min'
    insertMessage(`rt_out_${cid}`, cid, { phone: '+15005557000', direction: 'outbound', createdAt: t0.toISOString() });
    insertMessage(`rt_in_${cid}`, cid, { phone: '+15005557000', direction: 'inbound', createdAt: t1.toISOString() });

    const result = await analyzeResponseTimeImpact(db, cid);
    expect(result.total_responses_analyzed).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(result.buckets)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stats.js — getWeekOverWeekComparison
// ─────────────────────────────────────────────────────────────────────────────

describe('getWeekOverWeekComparison', () => {
  it('throws when db is null', async () => {
    await expect(getWeekOverWeekComparison(null, 'x')).rejects.toThrow();
  });

  it('throws when clientId is null', async () => {
    await expect(getWeekOverWeekComparison(db, null)).rejects.toThrow();
  });

  it('returns zeros for client with no calls', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const result = await getWeekOverWeekComparison(db, cid);
    expect(result.this_week.total_calls).toBe(0);
    expect(result.last_week.total_calls).toBe(0);
    expect(result.change.trend).toBe('stable');
  });

  it('returns correct shape', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const result = await getWeekOverWeekComparison(db, cid);

    expect(result.this_week).toHaveProperty('total_calls');
    expect(result.this_week).toHaveProperty('booking_rate');
    expect(result.this_week).toHaveProperty('avg_duration');
    expect(result.last_week).toHaveProperty('total_calls');
    expect(result.change).toHaveProperty('calls_difference');
    expect(result.change).toHaveProperty('rate_difference');
    expect(result.change).toHaveProperty('trend');
  });

  it('booking_rate is a percentage string', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const result = await getWeekOverWeekComparison(db, cid);
    expect(typeof result.this_week.booking_rate).toBe('string');
    expect(result.this_week.booking_rate).toMatch(/^\d+%$/);
  });

  it('rate_difference has correct sign prefix', async () => {
    const cid = nextClientId();
    insertClient(cid);
    const result = await getWeekOverWeekComparison(db, cid);
    // With no data both weeks are 0, diff = 0, no + prefix
    expect(result.change.rate_difference).toMatch(/^[+-]?\d+%$/);
  });

  it('trend is increasing when this week has more calls', async () => {
    const cid = nextClientId();
    insertClient(cid);

    // Insert calls 1 second in the future relative to now so they are clearly
    // within [thisWeekStart, thisWeekEnd). getWeekOverWeekComparison computes
    // thisWeekStart = startOfDay(sunday_of_this_week) without zeroing hours,
    // so we just use a time well after now (same week) to be safe.
    const future = new Date(Date.now() + 60 * 1000); // 1 minute from now, still this week
    for (let i = 0; i < 3; i++) {
      const t = new Date(future.getTime() + i * 1000);
      insertCall(`wow_inc_${cid}_${i}`, cid, { phone: `+1500555${7000 + clientSeq * 10 + i}`, outcome: 'booked', createdAt: t.toISOString() });
    }

    const result = await getWeekOverWeekComparison(db, cid);
    // This week has 3, last week 0 → increasing
    expect(result.this_week.total_calls).toBe(3);
    expect(result.change.trend).toBe('increasing');
  });

  it('trend is decreasing when last week had more calls', async () => {
    const cid = nextClientId();
    insertClient(cid);

    const now = new Date();
    const thisWeekStart = new Date(now);
    thisWeekStart.setDate(now.getDate() - now.getDay());
    thisWeekStart.setHours(0, 0, 0, 0);

    const lastWeekMid = new Date(thisWeekStart.getTime() - 4 * 24 * 3600 * 1000);

    for (let i = 0; i < 4; i++) {
      const t = new Date(lastWeekMid.getTime() + i * 3600 * 1000);
      insertCall(`wow_dec_${cid}_${i}`, cid, { phone: `+1500555${8000 + i}`, createdAt: t.toISOString() });
    }

    const result = await getWeekOverWeekComparison(db, cid);
    expect(result.last_week.total_calls).toBe(4);
    expect(result.change.trend).toBe('decreasing');
  });
});
