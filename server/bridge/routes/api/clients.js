const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { isValidUUID } = require('../../utils/validate');
const { logger } = require('../../utils/logger');
const { validateEmail, validatePhone, validateLength, LENGTH_LIMITS } = require('../../utils/inputValidation');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Whitelist of allowed client fields for updates (prevents SQL injection)
const ALLOWED_CLIENT_FIELDS = new Set([
  'business_name', 'business_address', 'phone', 'email', 'website',
  'google_review_link', 'ticket_price', 'timezone', 'ai_enabled',
  'booking_link', 'industry', 'auto_followup_enabled',
  'owner_name', 'owner_phone', 'owner_email',
  'retell_agent_id', 'retell_phone', 'twilio_phone', 'transfer_phone',
  'calcom_event_type_id', 'calcom_booking_link', 'telegram_chat_id',
  'avg_ticket', 'is_active', 'plan'
]);

// GET /clients
router.get('/clients', (req, res) => {
  try {
    const db = req.app.locals.db;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
    const offset = (page - 1) * limit;

    let clients;
    let total;
    if (req.isAdmin) {
      total = db.prepare('SELECT COUNT(*) as count FROM clients').get().count;
      clients = db.prepare('SELECT * FROM clients ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
    } else if (req.clientId) {
      clients = db.prepare('SELECT * FROM clients WHERE id = ?').all(req.clientId);
      total = clients.length;
    } else {
      return res.status(403).json({ error: 'Forbidden' });
    }
    res.json({ data: clients, meta: { page, limit, total, total_pages: Math.ceil(total / limit) } });
  } catch (err) {
    logger.error('[api] clients error:', err);
    res.status(500).json({ error: 'Failed to fetch clients' });
  }
});

// POST /clients
router.post('/clients', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const {
      business_name, owner_name, owner_phone, owner_email,
      retell_agent_id, retell_phone, twilio_phone, transfer_phone, industry, timezone,
      calcom_event_type_id, calcom_booking_link,
      avg_ticket, knowledge_base
    } = req.body;

    // Validate required business_name
    if (!business_name) {
      return res.status(400).json({ error: 'business_name is required' });
    }

    // Validate input lengths
    const nameValidation = validateLength(business_name, 'business_name', LENGTH_LIMITS.name);
    if (!nameValidation.valid) {
      return res.status(400).json({ error: nameValidation.error });
    }

    // Validate owner_email if provided
    if (owner_email) {
      const emailValidation = validateEmail(owner_email);
      if (!emailValidation.valid) {
        return res.status(400).json({ error: emailValidation.error });
      }
    }

    // Validate owner_phone if provided
    if (owner_phone) {
      const phoneValidation = validatePhone(owner_phone);
      if (!phoneValidation.valid) {
        return res.status(400).json({ error: phoneValidation.error });
      }
    }

    // Validate other phone fields if provided
    if (retell_phone) {
      const phoneValidation = validatePhone(retell_phone);
      if (!phoneValidation.valid) {
        return res.status(400).json({ error: `Invalid retell_phone: ${phoneValidation.error}` });
      }
    }

    if (twilio_phone) {
      const phoneValidation = validatePhone(twilio_phone);
      if (!phoneValidation.valid) {
        return res.status(400).json({ error: `Invalid twilio_phone: ${phoneValidation.error}` });
      }
    }

    if (transfer_phone) {
      const phoneValidation = validatePhone(transfer_phone);
      if (!phoneValidation.valid) {
        return res.status(400).json({ error: `Invalid transfer_phone: ${phoneValidation.error}` });
      }
    }

    // Validate optional text fields
    if (owner_name) {
      const validation = validateLength(owner_name, 'owner_name', LENGTH_LIMITS.name);
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }
    }

    if (industry) {
      const validation = validateLength(industry, 'industry', LENGTH_LIMITS.name);
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }
    }

    if (calcom_booking_link) {
      const validation = validateLength(calcom_booking_link, 'calcom_booking_link', LENGTH_LIMITS.url);
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }
    }

    const id = randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO clients (
        id, business_name, owner_name, owner_phone, owner_email,
        retell_agent_id, retell_phone, twilio_phone, transfer_phone, industry, timezone,
        calcom_event_type_id, calcom_booking_link,
        avg_ticket, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, business_name, owner_name || null, owner_phone || null, owner_email || null,
      retell_agent_id || null, retell_phone || null, twilio_phone || null, transfer_phone || null, industry || null, timezone || 'UTC',
      calcom_event_type_id || null, calcom_booking_link || null,
      avg_ticket || 0, now, now
    );

    // Save knowledge base JSON if provided (UUID validated — id is from randomUUID())
    if (knowledge_base) {
      const kbDir = path.join(__dirname, '../../../mcp/knowledge_bases');
      try {
        await fsPromises.mkdir(kbDir, { recursive: true });
        await fsPromises.writeFile(path.join(kbDir, `${id}.json`), JSON.stringify(knowledge_base, null, 2));
      } catch (err) {
        logger.error('[api] Failed to save KB:', err.message);
      }
    }

    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
    res.status(201).json({ data: client });
  } catch (err) {
    logger.error('[api] create client error:', err);
    res.status(500).json({ error: 'Failed to create client' });
  }
});

// PUT /clients/:clientId
router.put('/clients/:clientId', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;
    if (!UUID_RE.test(clientId)) return res.status(400).json({ error: 'Invalid client ID format' });
    const updates = req.body;

    const existing = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
    if (!existing) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const setClauses = [];
    const values = [];

    // Only allow whitelisted fields to prevent SQL injection
    for (const field in updates) {
      if (ALLOWED_CLIENT_FIELDS.has(field) && updates[field] !== undefined) {
        const value = updates[field];

        // Validate field lengths and formats based on field type
        if (field === 'business_name' && value) {
          const validation = validateLength(value, field, LENGTH_LIMITS.name);
          if (!validation.valid) {
            return res.status(400).json({ error: validation.error });
          }
        }

        if (field === 'email' && value) {
          const validation = validateEmail(value);
          if (!validation.valid) {
            return res.status(400).json({ error: validation.error });
          }
        }

        if (field === 'owner_email' && value) {
          const validation = validateEmail(value);
          if (!validation.valid) {
            return res.status(400).json({ error: validation.error });
          }
        }

        if (['phone', 'owner_phone', 'retell_phone', 'twilio_phone', 'transfer_phone'].includes(field) && value) {
          const validation = validatePhone(value);
          if (!validation.valid) {
            return res.status(400).json({ error: `Invalid ${field}: ${validation.error}` });
          }
        }

        if (['business_address', 'owner_name', 'industry', 'website', 'google_review_link', 'calcom_booking_link', 'booking_link'].includes(field) && value) {
          const validation = validateLength(value, field, LENGTH_LIMITS.text);
          if (!validation.valid) {
            return res.status(400).json({ error: validation.error });
          }
        }

        setClauses.push(`${field} = ?`);
        values.push(value);
      }
    }

    if (setClauses.length === 0 && !updates.knowledge_base) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    if (setClauses.length > 0) {
      setClauses.push('updated_at = ?');
      values.push(new Date().toISOString());
      values.push(clientId);

      db.prepare(`UPDATE clients SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
    }

    // Update knowledge base if provided
    if (updates.knowledge_base) {
      const kbDir = path.join(__dirname, '../../../mcp/knowledge_bases');
      try {
        await fsPromises.mkdir(kbDir, { recursive: true });
        await fsPromises.writeFile(path.join(kbDir, `${clientId}.json`), JSON.stringify(updates.knowledge_base, null, 2));
      } catch (err) {
        logger.error('[api] Failed to save KB:', err.message);
      }
    }

    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
    res.json({ data: client });
  } catch (err) {
    logger.error('[api] update client error:', err);
    res.status(500).json({ error: 'Failed to update client' });
  }
});

module.exports = router;
