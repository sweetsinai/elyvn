const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { isValidUUID } = require('../../utils/validate');
const { logger } = require('../../utils/logger');
const { AppError } = require('../../utils/AppError');
const { validateEmail, validatePhone, validateLength, LENGTH_LIMITS } = require('../../utils/inputValidation');
const { cachedGet, invalidateCache, CACHE_TTL } = require('../../utils/dbAdapter');
const { parsePagination } = require('../../utils/dbHelpers');
const { logDataMutation } = require('../../utils/auditLog');
const { validateParams, validateBody, validateQuery } = require('../../middleware/validateRequest');
const { ClientParamsSchema, ClientCreateSchema } = require('../../utils/schemas/client');
const { PaginationSchema } = require('../../utils/schemas/common');
const { paginated } = require('../../utils/response');
const { clientIsolationParam } = require('../../utils/clientIsolation');
router.param('clientId', clientIsolationParam);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Safe columns to return — never expose password_hash, verification_token, verification_expires
const CLIENT_SAFE_COLS = 'id, business_name, name, owner_name, owner_email, owner_phone, industry, plan, subscription_status, stripe_customer_id, stripe_subscription_id, retell_agent_id, retell_phone, twilio_phone, telnyx_phone, transfer_phone, calcom_event_type_id, calcom_booking_link, google_review_link, telegram_chat_id, avg_ticket, is_active, notification_mode, whatsapp_phone, created_at, updated_at';

// Whitelist of allowed client fields for updates (prevents SQL injection)
const ALLOWED_CLIENT_FIELDS = new Set([
  'business_name', 'business_address', 'phone', 'email', 'website',
  'google_review_link', 'ticket_price', 'timezone', 'ai_enabled',
  'booking_link', 'industry', 'auto_followup_enabled',
  'owner_name', 'owner_phone', 'owner_email',
  'retell_agent_id', 'retell_phone', 'retell_voice', 'retell_language',
  'twilio_phone', 'transfer_phone',
  'calcom_event_type_id', 'calcom_booking_link', 'telegram_chat_id',
  'avg_ticket', 'is_active', 'plan',
  'notification_mode', 'whatsapp_phone',
  'facebook_page_id', 'instagram_user_id',
]);

// GET /clients — migrated to async db.query() for SQLite + Supabase compatibility
router.get('/clients', validateQuery(PaginationSchema), async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { page, limit, offset } = parsePagination(req.query, 25, 100);

    let clients;
    let total;
    if (req.isAdmin) {
      const countResult = await db.query('SELECT COUNT(*) as count FROM clients', [], 'get');
      total = countResult.count;
      clients = await db.query(`SELECT ${CLIENT_SAFE_COLS} FROM clients ORDER BY created_at DESC LIMIT ? OFFSET ?`, [limit, offset], 'all');
    } else if (req.clientId) {
      // Use db.query for SQLite + Supabase compat
      const clientRecord = await db.query(`SELECT ${CLIENT_SAFE_COLS} FROM clients WHERE id = ?`, [req.clientId], 'get');
      clients = clientRecord ? [clientRecord] : [];
      total = clients.length;
    } else {
      return next(new AppError('FORBIDDEN', 'Forbidden', 403));
    }
    return paginated(res, { data: clients, total, limit, offset });
  } catch (err) {
    logger.error('[api] clients error:', err);
    return next(new AppError('INTERNAL_ERROR', 'Failed to fetch clients', 500));
  }
});

// POST /clients — admin only
router.post('/clients', validateBody(ClientCreateSchema), async (req, res, next) => {
  if (!req.isAdmin) return next(new AppError('FORBIDDEN', 'Admin access required', 403));
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
      return next(new AppError('MISSING_FIELD', 'business_name is required', 400));
    }

    // Validate input lengths
    const nameValidation = validateLength(business_name, 'business_name', LENGTH_LIMITS.name);
    if (!nameValidation.valid) {
      return next(new AppError('VALIDATION_ERROR',nameValidation.error, 422));
    }

    // Validate owner_email if provided
    if (owner_email) {
      const emailValidation = validateEmail(owner_email);
      if (!emailValidation.valid) {
        return next(new AppError('VALIDATION_ERROR',emailValidation.error, 422));
      }
    }

    // Validate owner_phone if provided
    if (owner_phone) {
      const phoneValidation = validatePhone(owner_phone);
      if (!phoneValidation.valid) {
        return next(new AppError('VALIDATION_ERROR',phoneValidation.error, 422));
      }
    }

    // Validate other phone fields if provided
    if (retell_phone) {
      const phoneValidation = validatePhone(retell_phone);
      if (!phoneValidation.valid) {
        return next(new AppError('VALIDATION_ERROR',`Invalid retell_phone: ${phoneValidation.error}`, 422));
      }
    }

    if (twilio_phone) {
      const phoneValidation = validatePhone(twilio_phone);
      if (!phoneValidation.valid) {
        return next(new AppError('VALIDATION_ERROR',`Invalid twilio_phone: ${phoneValidation.error}`, 422));
      }
    }

    if (transfer_phone) {
      const phoneValidation = validatePhone(transfer_phone);
      if (!phoneValidation.valid) {
        return next(new AppError('VALIDATION_ERROR',`Invalid transfer_phone: ${phoneValidation.error}`, 422));
      }
    }

    // Validate optional text fields
    if (owner_name) {
      const validation = validateLength(owner_name, 'owner_name', LENGTH_LIMITS.name);
      if (!validation.valid) {
        return next(new AppError('VALIDATION_ERROR',validation.error, 422));
      }
    }

    if (industry) {
      const validation = validateLength(industry, 'industry', LENGTH_LIMITS.name);
      if (!validation.valid) {
        return next(new AppError('VALIDATION_ERROR',validation.error, 422));
      }
    }

    if (calcom_booking_link) {
      const validation = validateLength(calcom_booking_link, 'calcom_booking_link', LENGTH_LIMITS.url);
      if (!validation.valid) {
        return next(new AppError('VALIDATION_ERROR',validation.error, 422));
      }
    }

    const id = randomUUID();
    const now = new Date().toISOString();

    await db.query(`
      INSERT INTO clients (
        id, business_name, owner_name, owner_phone, owner_email,
        retell_agent_id, retell_phone, twilio_phone, transfer_phone, industry, timezone,
        calcom_event_type_id, calcom_booking_link,
        avg_ticket, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id, business_name, owner_name || null, owner_phone || null, owner_email || null,
      retell_agent_id || null, retell_phone || null, twilio_phone || null, transfer_phone || null, industry || null, timezone || 'UTC',
      calcom_event_type_id || null, calcom_booking_link || null,
      avg_ticket || 0, now, now
    ], 'run');

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

    const client = await db.query(`SELECT ${CLIENT_SAFE_COLS} FROM clients WHERE id = ?`, [id], 'get');
    res.status(201).json({ data: client });
  } catch (err) {
    logger.error('[api] create client error:', err);
    return next(new AppError('INTERNAL_ERROR', 'Failed to create client', 500));
  }
});

// PUT /clients/:clientId — migrated to async db.query() for SQLite + Supabase compatibility
router.put('/clients/:clientId', validateParams(ClientParamsSchema), async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;
    if (!UUID_RE.test(clientId)) return next(new AppError('INVALID_INPUT', 'Invalid client ID format', 400));
    const updates = req.body;

    const existing = await db.query(`SELECT ${CLIENT_SAFE_COLS} FROM clients WHERE id = ?`, [clientId], 'get');
    if (!existing) {
      return next(new AppError('NOT_FOUND', 'Client not found', 404));
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
            return next(new AppError('VALIDATION_ERROR',validation.error, 422));
          }
        }

        if (field === 'email' && value) {
          const validation = validateEmail(value);
          if (!validation.valid) {
            return next(new AppError('VALIDATION_ERROR',validation.error, 422));
          }
        }

        if (field === 'owner_email' && value) {
          const validation = validateEmail(value);
          if (!validation.valid) {
            return next(new AppError('VALIDATION_ERROR',validation.error, 422));
          }
        }

        if (['phone', 'owner_phone', 'retell_phone', 'twilio_phone', 'transfer_phone'].includes(field) && value) {
          const validation = validatePhone(value);
          if (!validation.valid) {
            return next(new AppError('VALIDATION_ERROR',`Invalid ${field}: ${validation.error}`, 422));
          }
        }

        if (['business_address', 'owner_name', 'industry', 'website', 'google_review_link', 'calcom_booking_link', 'booking_link'].includes(field) && value) {
          const validation = validateLength(value, field, LENGTH_LIMITS.text);
          if (!validation.valid) {
            return next(new AppError('VALIDATION_ERROR',validation.error, 422));
          }
        }

        setClauses.push(`${field} = ?`);
        values.push(value);
      }
    }

    if (setClauses.length === 0 && !updates.knowledge_base) {
      return next(new AppError('VALIDATION_ERROR','No valid fields to update', 422));
    }

    // Wrap the SELECT + UPDATE + final SELECT in a transaction so the read
    // and write are atomic. The KB file write stays outside — it's a filesystem op.
    let client;
    if (db._async) {
      // PostgreSQL path — supabase adapter's transaction() returns an async function
      client = await db.transaction(async function(txDb) {
        const current = await txDb.query(`SELECT ${CLIENT_SAFE_COLS} FROM clients WHERE id = ?`, [clientId], 'get');
        if (!current) throw new AppError('NOT_FOUND', 'Client not found', 404);

        if (setClauses.length > 0) {
          const txSetClauses = [...setClauses, 'updated_at = ?'];
          const txValues = [...values, new Date().toISOString(), clientId];
          await txDb.query(`UPDATE clients SET ${txSetClauses.join(', ')} WHERE id = ?`, txValues, 'run');
        }

        return txDb.query(`SELECT ${CLIENT_SAFE_COLS} FROM clients WHERE id = ?`, [clientId], 'get');
      })();
    } else {
      // SQLite path — better-sqlite3 transaction() is synchronous; use prepare() directly
      const updatedAt = new Date().toISOString();
      const txResult = db.transaction(() => {
        const current = db.prepare(`SELECT ${CLIENT_SAFE_COLS} FROM clients WHERE id = ?`).get(clientId);
        if (!current) throw new AppError('NOT_FOUND', 'Client not found', 404);

        if (setClauses.length > 0) {
          const txSetClauses = [...setClauses, 'updated_at = ?'];
          const txValues = [...values, updatedAt, clientId];
          db.prepare(`UPDATE clients SET ${txSetClauses.join(', ')} WHERE id = ?`).run(...txValues);
        }

        return db.prepare(`SELECT ${CLIENT_SAFE_COLS} FROM clients WHERE id = ?`).get(clientId);
      })();
      client = txResult;
    }

    // Invalidate cache after mutation
    invalidateCache('client:' + clientId);

    // Fire-and-forget: audit trail for client mutation
    try {
      const changedFields = {};
      const oldFields = {};
      for (const field of setClauses.map(c => c.split(' = ')[0])) {
        if (field === 'updated_at') continue;
        if (existing[field] !== updates[field]) {
          oldFields[field] = existing[field];
          changedFields[field] = updates[field];
        }
      }
      if (Object.keys(changedFields).length > 0) {
        logDataMutation(db, {
          action: 'client_updated',
          table: 'clients',
          recordId: clientId,
          clientId,
          oldValues: oldFields,
          newValues: changedFields,
          ip: req.ip,
        });
      }
    } catch (_) {}

    // Update knowledge base if provided (filesystem op — outside transaction intentionally)
    if (updates.knowledge_base) {
      const kbDir = path.join(__dirname, '../../../mcp/knowledge_bases');
      try {
        await fsPromises.mkdir(kbDir, { recursive: true });
        await fsPromises.writeFile(path.join(kbDir, `${clientId}.json`), JSON.stringify(updates.knowledge_base, null, 2));
      } catch (err) {
        logger.error('[api] Failed to save KB:', err.message);
      }
    }

    res.json({ data: client });
  } catch (err) {
    logger.error('[api] update client error:', err);
    return next(new AppError('INTERNAL_ERROR', 'Failed to update client', 500));
  }
});

module.exports = router;
