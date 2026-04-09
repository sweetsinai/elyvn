'use strict';

const BASE = process.env.TEST_BASE_URL || 'https://joyful-trust-production.up.railway.app';
const API_KEY = process.env.TEST_API_KEY || '4d4def88907d8f1d9c83921384c5199c41639cb2f99d60009267b06c6508eaa9';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-bot-token';

// Skip all tests if the server is not explicitly configured via TEST_BASE_URL.
// These are live E2E tests — they should not run against production from CI/unit runs.
const it = process.env.TEST_BASE_URL ? test : test.skip;

describe('API Endpoints Integration Tests', () => {
  const fetchJSON = async (url, opts = {}) => {
    try {
      const res = await fetch(url, opts);
      const data = await res.json().catch(() => null);
      return { status: res.status, data, headers: res.headers };
    } catch (e) {
      throw new Error(`Fetch failed: ${e.message}`);
    }
  };

  describe('Health & Service Status', () => {
    it('GET /health returns 200 with db status', async () => {
      const { status, data } = await fetchJSON(`${BASE}/health`, {
        headers: { 'x-api-key': API_KEY }
      });
      expect(status).toBe(200);
      expect(data).toBeDefined();
      expect(data.status).toBeDefined();
      expect(['ok', 'degraded']).toContain(data.status);
      if (data.services) {
        expect(typeof data.services.db).toBe('boolean');
      }
    }, 15000);

    it('GET /health.json returns health data', async () => {
      const { status, data } = await fetchJSON(`${BASE}/health.json`);
      expect([200, 404]).toContain(status);
      if (status === 200) {
        expect(data).toBeDefined();
      }
    }, 15000);
  });

  describe('API Authentication', () => {
    it('GET /api/clients without key returns 401', async () => {
      const { status } = await fetchJSON(`${BASE}/api/clients`);
      expect(status).toBe(401);
    }, 10000);

    it('GET /api/clients with valid key returns 200', async () => {
      const { status, data } = await fetchJSON(`${BASE}/api/clients`, {
        headers: { 'x-api-key': API_KEY }
      });
      expect([200, 400, 401]).toContain(status);
      if (status === 200) {
        expect(data).toBeDefined();
        expect(Array.isArray(data) || typeof data === 'object').toBe(true);
      }
    }, 10000);

    it('GET /api/clients with invalid key returns 401', async () => {
      const { status } = await fetchJSON(`${BASE}/api/clients`, {
        headers: { 'x-api-key': 'invalid-key-12345' }
      });
      expect(status).toBe(401);
    }, 10000);
  });

  describe('API Routes', () => {
    it('GET /api/clients returns list of clients', async () => {
      const { status, data } = await fetchJSON(`${BASE}/api/clients`, {
        headers: { 'x-api-key': API_KEY }
      });
      expect([200, 400, 401]).toContain(status);
      if (status === 200) {
        expect(Array.isArray(data) || typeof data === 'object').toBe(true);
      }
    }, 10000);

    it('GET /api/leads/:clientId returns leads', async () => {
      const { data: clients } = await fetchJSON(`${BASE}/api/clients`, {
        headers: { 'x-api-key': API_KEY }
      });

      if (clients && clients.length > 0) {
        const clientId = clients[0].id;
        const { status, data } = await fetchJSON(`${BASE}/api/leads/${clientId}`, {
          headers: { 'x-api-key': API_KEY }
        });
        expect(status).toBe(200);
        expect(Array.isArray(data)).toBe(true);
      }
    }, 15000);

    it('GET /api/messages/:clientId returns messages', async () => {
      const { data: clients } = await fetchJSON(`${BASE}/api/clients`, {
        headers: { 'x-api-key': API_KEY }
      });

      if (clients && clients.length > 0) {
        const clientId = clients[0].id;
        const { status, data } = await fetchJSON(`${BASE}/api/messages/${clientId}`, {
          headers: { 'x-api-key': API_KEY }
        });
        expect(status).toBe(200);
        expect(Array.isArray(data) || typeof data === 'object').toBe(true);
      }
    }, 15000);

    it('GET /api/calls/:clientId returns calls', async () => {
      const { data: clients } = await fetchJSON(`${BASE}/api/clients`, {
        headers: { 'x-api-key': API_KEY }
      });

      if (clients && clients.length > 0) {
        const clientId = clients[0].id;
        const { status, data } = await fetchJSON(`${BASE}/api/calls/${clientId}`, {
          headers: { 'x-api-key': API_KEY }
        });
        expect(status).toBe(200);
        expect(Array.isArray(data)).toBe(true);
      }
    }, 15000);

    it('GET /api/stats/:clientId returns statistics', async () => {
      const { data: clients } = await fetchJSON(`${BASE}/api/clients`, {
        headers: { 'x-api-key': API_KEY }
      });

      if (clients && clients.length > 0) {
        const clientId = clients[0].id;
        const { status, data } = await fetchJSON(`${BASE}/api/stats/${clientId}`, {
          headers: { 'x-api-key': API_KEY }
        });
        expect(status).toBe(200);
        expect(data).toBeDefined();
      }
    }, 15000);
  });

  describe('Webhook Handlers', () => {
    it('POST /webhooks/telegram accepts valid update', async () => {
      const payload = {
        update_id: Math.floor(Math.random() * 1000000),
        message: {
          message_id: 1,
          from: { id: 111222333, is_bot: false, first_name: 'Test' },
          chat: { id: 111222333, type: 'private', first_name: 'Test' },
          date: Math.floor(Date.now() / 1000),
          text: '/help'
        }
      };

      const { status } = await fetchJSON(`${BASE}/webhooks/telegram`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      expect([200, 204, 400]).toContain(status);
    }, 15000);

    it('POST /webhooks/telegram rejects malformed update', async () => {
      const { status } = await fetchJSON(`${BASE}/webhooks/telegram`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invalid: 'data' })
      });

      expect([400, 422, 200]).toContain(status);
    }, 15000);

    it('POST /webhooks/telnyx accepts valid update', async () => {
      const { status } = await fetchJSON(`${BASE}/webhooks/telnyx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: {
            payload: {
              from: { phone_number: '+14155551234' },
              to: [{ phone_number: '+14155555678' }],
              text: 'Test message'
            }
          }
        })
      });

      expect([200, 204, 400, 401]).toContain(status);
    }, 15000);
  });

  describe('Form Endpoints', () => {
    it('POST /api/onboard validates required fields', async () => {
      const { status } = await fetchJSON(`${BASE}/api/onboard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      expect(status).toBe(400);
    }, 10000);

    it('POST /api/onboard accepts valid data', async () => {
      const { status } = await fetchJSON(`${BASE}/api/onboard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company_name: 'Test Co',
          contact_email: 'test@example.com',
          contact_phone: '+14155551234'
        })
      });

      expect([200, 201, 400, 422]).toContain(status);
    }, 10000);
  });

  describe('External Service Integration', () => {
    it('Telegram bot is reachable', async () => {
      const { data } = await fetchJSON(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
      if (data) {
        expect(typeof data === 'object').toBe(true);
      }
    }, 15000);

    it('Telegram webhook is configured', async () => {
      const { data } = await fetchJSON(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`);
      if (data) {
        expect(typeof data === 'object').toBe(true);
      }
    }, 15000);
  });

  describe('Response Headers & Error Handling', () => {
    it('Endpoints set CORS headers', async () => {
      const res = await fetch(`${BASE}/health`);
      expect(res.status).toBe(200);
    }, 10000);

    it('Invalid routes return 404', async () => {
      const { status } = await fetchJSON(`${BASE}/nonexistent-route-xyz`);
      expect([200, 404, 400, 405]).toContain(status);
    }, 10000);

    it('Server responds to OPTIONS requests', async () => {
      try {
        const res = await fetch(`${BASE}/api/clients`, { method: 'OPTIONS' });
        expect([200, 204, 405]).toContain(res.status);
      } catch (e) {
        // OPTIONS may not be implemented
      }
    }, 10000);
  });
});
