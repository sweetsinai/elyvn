'use strict';

const request = require('supertest');
const express = require('express');
const { randomUUID } = require('crypto');

// ─── Mocks (must come before any require of route files) ─────────────────────

jest.mock('../utils/config', () => ({
  ai: { model: 'claude-3-5-sonnet-20241022' },
  outreach: {
    dailySendLimit: 300,
    senderName: 'Sohan',
    bookingLink: 'https://cal.com/elyvn/demo',
  },
}));

jest.mock('../utils/logger', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

jest.mock('../utils/auditLog', () => ({
  logDataMutation: jest.fn(),
}));

jest.mock('../utils/dbAdapter', () => ({
  isAsync: jest.fn(() => false),
}));

jest.mock('../utils/emailGenerator', () => ({
  generateColdEmail: jest.fn().mockResolvedValue({
    subject_a: 'Subject A',
    subject_b: 'Subject B',
    body: 'Email body text',
  }),
  pickVariant: jest.fn((idx) => (idx % 2 === 0 ? 'A' : 'B')),
}));

jest.mock('../middleware/rateLimits', () => ({
  emailSendLimit: (req, res, next) => next(),
}));

// ─── Route under test ────────────────────────────────────────────────────────

const campaignsRouter = require('../routes/campaigns');

// ─── Test helpers ─────────────────────────────────────────────────────────────

const VALID_API_KEY = 'test-campaigns-api-key';

function buildApp(db, { isAdmin = true, clientId } = {}) {
  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    const key = req.headers['x-api-key'];
    if (!key) return res.status(401).json({ error: 'API key required' });
    if (key !== VALID_API_KEY) return res.status(401).json({ error: 'Invalid API key' });
    req.isAdmin = isAdmin;
    req.clientId = clientId || testClientId;
    next();
  });

  app.use('/', campaignsRouter);

  // Error handler
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.statusCode || err.status || 500;
    res.status(status).json({ error: err.message, code: err.code });
  });

  app.locals.db = db;
  return app;
}

// ─── Test data ───────────────────────────────────────────────────────────────

let testClientId;
let testCampaignId;
let testProspectId1;
let testProspectId2;

beforeAll(() => {
  testClientId = randomUUID();
  testCampaignId = randomUUID();
  testProspectId1 = randomUUID();
  testProspectId2 = randomUUID();
});

// ─── Mock DB factory ─────────────────────────────────────────────────────────

function createMockDb({ campaign = null, prospects = [], variantA = null, variantB = null } = {}) {
  const db = {
    query: jest.fn((sql, params = [], mode = 'all') => {
      const s = sql.replace(/\s+/g, ' ').trim();

      // Transactional control
      if (/^BEGIN|^COMMIT|^ROLLBACK/.test(s)) return Promise.resolve();

      // INSERT campaigns / campaign_prospects / emails_sent → run
      if (mode === 'run') return Promise.resolve({ changes: 1 });

      // SELECT campaign by id
      if (mode === 'get' && s.includes('FROM campaigns WHERE id')) {
        return Promise.resolve(campaign);
      }

      // SELECT prospects in campaign
      if (mode === 'all' && s.includes('FROM prospects') && s.includes('JOIN campaign_prospects')) {
        return Promise.resolve(prospects);
      }

      // A/B variant stats (get mode + campaign_id filter + variant)
      if (mode === 'get' && s.includes('FROM emails_sent') && s.includes('variant =')) {
        const isA = s.includes("variant = 'A'") || (params && params.includes('A'));
        return Promise.resolve(isA
          ? (variantA || { sent: 0, opened: 0, clicked: 0 })
          : (variantB || { sent: 0, opened: 0, clicked: 0 }));
      }

      // Top subject queries
      if (mode === 'get' && s.includes('GROUP BY subject')) {
        return Promise.resolve(null);
      }

      return Promise.resolve(null);
    }),
    // SQLite-style transaction (used when isAsync returns false)
    transaction: jest.fn((fn) => (...args) => fn(...args)),
    prepare: jest.fn(() => ({
      run: jest.fn(),
    })),
  };

  return db;
}

// ─── POST /campaign ──────────────────────────────────────────────────────────

describe('POST /campaign', () => {
  test('returns 401 without API key', async () => {
    const app = buildApp(createMockDb());
    const res = await request(app).post('/campaign').send({
      name: 'My Campaign',
      prospectIds: [testProspectId1],
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('API key required');
  });

  test('returns 401 with invalid API key', async () => {
    const app = buildApp(createMockDb());
    const res = await request(app)
      .post('/campaign')
      .set('x-api-key', 'wrong-key')
      .send({ name: 'My Campaign', prospectIds: [testProspectId1] });
    expect(res.status).toBe(401);
  });

  test('returns 400 when name is missing', async () => {
    const app = buildApp(createMockDb());
    const res = await request(app)
      .post('/campaign')
      .set('x-api-key', VALID_API_KEY)
      .send({ prospectIds: [testProspectId1] });
    expect(res.status).toBe(400);
  });

  test('returns 400 when prospectIds is empty', async () => {
    const app = buildApp(createMockDb());
    const res = await request(app)
      .post('/campaign')
      .set('x-api-key', VALID_API_KEY)
      .send({ name: 'My Campaign', prospectIds: [] });
    expect(res.status).toBe(400);
  });

  test('returns 400 when prospectIds contains invalid UUIDs', async () => {
    const app = buildApp(createMockDb());
    const res = await request(app)
      .post('/campaign')
      .set('x-api-key', VALID_API_KEY)
      .send({ name: 'My Campaign', prospectIds: ['not-a-uuid'] });
    expect(res.status).toBe(400);
  });

  test('sanitizes XSS tags from name — strips tags, keeps inner text', async () => {
    const db = createMockDb();
    const app = buildApp(db);
    const res = await request(app)
      .post('/campaign')
      .set('x-api-key', VALID_API_KEY)
      .send({ name: '<script>alert(1)</script>', prospectIds: [testProspectId1] });
    // safeString strips HTML tags leaving "alert(1)" which is non-empty → passes validation
    // The route should still create the campaign with the sanitized name
    expect(res.status).toBe(201);
    expect(res.body.campaign.name).toBe('alert(1)');
  });

  test('creates campaign and returns 201 with single prospect', async () => {
    const db = createMockDb();
    const app = buildApp(db);
    const res = await request(app)
      .post('/campaign')
      .set('x-api-key', VALID_API_KEY)
      .send({ name: 'Test Campaign', prospectIds: [testProspectId1] });
    expect(res.status).toBe(201);
    expect(res.body.campaign).toMatchObject({
      name: 'Test Campaign',
      status: 'draft',
      prospect_count: 1,
    });
    expect(res.body.campaign.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  test('creates campaign with optional industry and city', async () => {
    const db = createMockDb();
    const app = buildApp(db);
    const res = await request(app)
      .post('/campaign')
      .set('x-api-key', VALID_API_KEY)
      .send({
        name: 'Plumbers NYC',
        industry: 'Plumbing',
        city: 'New York',
        prospectIds: [testProspectId1, testProspectId2],
      });
    expect(res.status).toBe(201);
    expect(res.body.campaign.industry).toBe('Plumbing');
    expect(res.body.campaign.city).toBe('New York');
    expect(res.body.campaign.prospect_count).toBe(2);
  });

  test('returns 500 on db error', async () => {
    const db = {
      query: jest.fn().mockRejectedValue(new Error('DB failure')),
      transaction: jest.fn(() => () => { throw new Error('DB failure'); }),
    };
    const app = buildApp(db);
    const res = await request(app)
      .post('/campaign')
      .set('x-api-key', VALID_API_KEY)
      .send({ name: 'My Campaign', prospectIds: [testProspectId1] });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to create campaign');
  });
});

// ─── POST /campaign/:campaignId/generate ────────────────────────────────────

describe('POST /campaign/:campaignId/generate', () => {
  const validCampaign = () => ({
    id: testCampaignId,
    name: 'Test Campaign',
    client_id: testClientId,
    status: 'draft',
  });

  const validProspects = () => [
    {
      id: testProspectId1,
      business_name: 'ACME Corp',
      email: 'owner@acme.com',
      phone: '+14155550001',
      status: 'active',
    },
    {
      id: testProspectId2,
      business_name: 'Globex',
      email: 'globex@example.com',
      phone: null,
      status: 'active',
    },
  ];

  test('returns 401 without API key', async () => {
    const app = buildApp(createMockDb({ campaign: validCampaign(), prospects: validProspects() }));
    const res = await request(app).post(`/campaign/${testCampaignId}/generate`);
    expect(res.status).toBe(401);
  });

  test('returns 400 with invalid campaignId (non-UUID)', async () => {
    const app = buildApp(createMockDb({ campaign: validCampaign(), prospects: validProspects() }));
    const res = await request(app)
      .post('/campaign/not-a-uuid/generate')
      .set('x-api-key', VALID_API_KEY);
    expect(res.status).toBe(400);
  });

  test('returns 404 when campaign does not exist', async () => {
    const app = buildApp(createMockDb({ campaign: null, prospects: [] }));
    const res = await request(app)
      .post(`/campaign/${testCampaignId}/generate`)
      .set('x-api-key', VALID_API_KEY);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Campaign not found');
  });

  test('returns 400 when campaign has no prospects', async () => {
    const app = buildApp(createMockDb({ campaign: validCampaign(), prospects: [] }));
    const res = await request(app)
      .post(`/campaign/${testCampaignId}/generate`)
      .set('x-api-key', VALID_API_KEY);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('No prospects in campaign');
  });

  test('returns 403 when non-admin client accesses another client campaign', async () => {
    const othersClientId = randomUUID();
    const campaign = { id: testCampaignId, client_id: othersClientId, name: 'Other', status: 'draft' };
    const app = buildApp(createMockDb({ campaign, prospects: validProspects() }), {
      isAdmin: false,
      clientId: testClientId,
    });
    const res = await request(app)
      .post(`/campaign/${testCampaignId}/generate`)
      .set('x-api-key', VALID_API_KEY);
    expect(res.status).toBe(403);
  });

  test('generates emails for all eligible prospects', async () => {
    const { generateColdEmail, pickVariant } = require('../utils/emailGenerator');
    generateColdEmail.mockResolvedValue({ subject_a: 'Sub A', subject_b: 'Sub B', body: 'Body' });
    pickVariant.mockImplementation((idx) => (idx % 2 === 0 ? 'A' : 'B'));

    const app = buildApp(createMockDb({ campaign: validCampaign(), prospects: validProspects() }));
    const res = await request(app)
      .post(`/campaign/${testCampaignId}/generate`)
      .set('x-api-key', VALID_API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.generated).toBe(2);
    expect(Array.isArray(res.body.emails)).toBe(true);
    expect(res.body.emails[0]).toMatchObject({ status: 'draft', to_email: 'owner@acme.com' });
  });

  test('skips bounced and unsubscribed prospects', async () => {
    const prospectsWithBad = [
      { id: testProspectId1, email: 'good@example.com', status: 'active', business_name: 'Good' },
      { id: testProspectId2, email: 'bad@example.com', status: 'bounced', business_name: 'Bad' },
      { id: randomUUID(), email: 'unsub@example.com', status: 'unsubscribed', business_name: 'Unsub' },
    ];
    const app = buildApp(createMockDb({ campaign: validCampaign(), prospects: prospectsWithBad }));
    const res = await request(app)
      .post(`/campaign/${testCampaignId}/generate`)
      .set('x-api-key', VALID_API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.generated).toBe(1);
  });

  test('skips prospects without email addresses', async () => {
    const prospectsNoEmail = [
      { id: testProspectId1, email: null, status: 'active', business_name: 'NoEmail' },
    ];
    const app = buildApp(createMockDb({ campaign: validCampaign(), prospects: prospectsNoEmail }));
    const res = await request(app)
      .post(`/campaign/${testCampaignId}/generate`)
      .set('x-api-key', VALID_API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.generated).toBe(0);
  });

  test('admin can generate emails for any client campaign', async () => {
    const othersClientId = randomUUID();
    const campaign = { id: testCampaignId, client_id: othersClientId, name: 'Other', status: 'draft' };
    const app = buildApp(createMockDb({ campaign, prospects: validProspects() }), {
      isAdmin: true,
      clientId: testClientId,
    });
    const res = await request(app)
      .post(`/campaign/${testCampaignId}/generate`)
      .set('x-api-key', VALID_API_KEY);
    expect(res.status).toBe(200);
  });

  test('continues generating remaining emails when one prospect fails', async () => {
    const { generateColdEmail } = require('../utils/emailGenerator');
    generateColdEmail
      .mockRejectedValueOnce(new Error('AI blip'))
      .mockResolvedValue({ subject_a: 'A', subject_b: 'B', body: 'Body' });

    const app = buildApp(createMockDb({ campaign: validCampaign(), prospects: validProspects() }));
    const res = await request(app)
      .post(`/campaign/${testCampaignId}/generate`)
      .set('x-api-key', VALID_API_KEY);
    expect(res.status).toBe(200);
    // First failed, second succeeded
    expect(res.body.generated).toBe(1);
  });
});

// ─── GET /campaign/:campaignId/ab-results ────────────────────────────────────

describe('GET /campaign/:campaignId/ab-results', () => {
  const validCampaign = () => ({
    id: testCampaignId,
    name: 'Test Campaign',
    client_id: testClientId,
    status: 'draft',
  });

  function buildDbWithVariants({ variantA, variantB } = {}) {
    const defaultA = { sent: 10, opened: 5, clicked: 2 };
    const defaultB = { sent: 8, opened: 3, clicked: 1 };

    const db = {
      query: jest.fn((sql, params = [], mode) => {
        const s = sql.replace(/\s+/g, ' ').trim();

        if (mode === 'get' && s.includes('FROM campaigns WHERE id')) {
          return Promise.resolve(validCampaign());
        }

        if (mode === 'get' && s.includes("variant = 'A'") && !s.includes('GROUP BY subject')) {
          return Promise.resolve(variantA || defaultA);
        }
        if (mode === 'get' && s.includes("variant = 'B'") && !s.includes('GROUP BY subject')) {
          return Promise.resolve(variantB || defaultB);
        }

        if (mode === 'get' && s.includes('GROUP BY subject') && s.includes("variant = 'A'")) {
          return Promise.resolve({ subject: 'Subject A', count: 5 });
        }
        if (mode === 'get' && s.includes('GROUP BY subject') && s.includes("variant = 'B'")) {
          return Promise.resolve({ subject: 'Subject B', count: 4 });
        }

        return Promise.resolve(null);
      }),
    };
    return db;
  }

  test('returns 401 without API key', async () => {
    const app = buildApp(buildDbWithVariants());
    const res = await request(app).get(`/campaign/${testCampaignId}/ab-results`);
    expect(res.status).toBe(401);
  });

  test('returns 400 with invalid campaignId', async () => {
    const app = buildApp(buildDbWithVariants());
    const res = await request(app)
      .get('/campaign/not-a-uuid/ab-results')
      .set('x-api-key', VALID_API_KEY);
    expect(res.status).toBe(400);
  });

  test('returns 404 when campaign does not exist', async () => {
    const db = {
      query: jest.fn(() => Promise.resolve(null)),
    };
    const app = buildApp(db);
    const res = await request(app)
      .get(`/campaign/${testCampaignId}/ab-results`)
      .set('x-api-key', VALID_API_KEY);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Campaign not found');
  });

  test('returns 403 for non-admin accessing another client campaign', async () => {
    const othersClientId = randomUUID();
    const db = {
      query: jest.fn((sql, params, mode) => {
        if (mode === 'get' && sql.includes('FROM campaigns WHERE id')) {
          return Promise.resolve({ id: testCampaignId, client_id: othersClientId, name: 'X', status: 'draft' });
        }
        return Promise.resolve(null);
      }),
    };
    const app = buildApp(db, { isAdmin: false, clientId: testClientId });
    const res = await request(app)
      .get(`/campaign/${testCampaignId}/ab-results`)
      .set('x-api-key', VALID_API_KEY);
    expect(res.status).toBe(403);
  });

  test('returns correct A/B stats and winner', async () => {
    const app = buildApp(
      buildDbWithVariants({
        variantA: { sent: 10, opened: 7, clicked: 3 },
        variantB: { sent: 10, opened: 4, clicked: 1 },
      })
    );
    const res = await request(app)
      .get(`/campaign/${testCampaignId}/ab-results`)
      .set('x-api-key', VALID_API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.variant_a.sent).toBe(10);
    expect(res.body.variant_a.opened).toBe(7);
    expect(res.body.variant_b.opened).toBe(4);
    expect(res.body.winner).toBe('A');
  });

  test('variant B wins when it has higher open rate', async () => {
    const app = buildApp(
      buildDbWithVariants({
        variantA: { sent: 10, opened: 2, clicked: 1 },
        variantB: { sent: 10, opened: 8, clicked: 3 },
      })
    );
    const res = await request(app)
      .get(`/campaign/${testCampaignId}/ab-results`)
      .set('x-api-key', VALID_API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.winner).toBe('B');
  });

  test('zero-sent variants produce zero rates and default to A win', async () => {
    const app = buildApp(
      buildDbWithVariants({
        variantA: { sent: 0, opened: 0, clicked: 0 },
        variantB: { sent: 0, opened: 0, clicked: 0 },
      })
    );
    const res = await request(app)
      .get(`/campaign/${testCampaignId}/ab-results`)
      .set('x-api-key', VALID_API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.variant_a.open_rate).toBe(0);
    expect(res.body.variant_b.open_rate).toBe(0);
    expect(res.body.winner).toBe('A');
  });

  test('includes top_subject N/A when no subjects found', async () => {
    const db = {
      query: jest.fn((sql, params = [], mode) => {
        const s = sql.replace(/\s+/g, ' ').trim();
        if (mode === 'get' && s.includes('FROM campaigns WHERE id')) {
          return Promise.resolve(validCampaign());
        }
        if (mode === 'get') return Promise.resolve({ sent: 0, opened: 0, clicked: 0 });
        return Promise.resolve(null);
      }),
    };
    const app = buildApp(db);
    const res = await request(app)
      .get(`/campaign/${testCampaignId}/ab-results`)
      .set('x-api-key', VALID_API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.variant_a.top_subject).toBe('N/A');
    expect(res.body.variant_b.top_subject).toBe('N/A');
  });

  test('admin can view any client campaign ab-results', async () => {
    const othersClientId = randomUUID();
    const db = {
      query: jest.fn((sql, params = [], mode) => {
        const s = sql.replace(/\s+/g, ' ').trim();
        if (mode === 'get' && s.includes('FROM campaigns WHERE id')) {
          return Promise.resolve({ id: testCampaignId, client_id: othersClientId, name: 'X', status: 'draft' });
        }
        if (mode === 'get') return Promise.resolve({ sent: 5, opened: 2, clicked: 1 });
        return Promise.resolve(null);
      }),
    };
    const app = buildApp(db, { isAdmin: true, clientId: testClientId });
    const res = await request(app)
      .get(`/campaign/${testCampaignId}/ab-results`)
      .set('x-api-key', VALID_API_KEY);
    expect(res.status).toBe(200);
  });
});
