/**
 * Social Channel Webhook — Facebook Messenger + Instagram DM
 *
 * Meta sends both Messenger and Instagram messages to the same webhook.
 * Setup: Create a Meta App, add Messenger + Instagram products,
 * subscribe to messages webhook, set URL to /webhooks/social.
 *
 * Env vars: META_VERIFY_TOKEN, META_APP_SECRET
 */
const express = require('express');
const router = express.Router();
const { createHmac, timingSafeEqual } = require('crypto');
const { logger } = require('../utils/logger');

// GET /webhooks/social — Meta webhook verification (subscription challenge)
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const verifyToken = process.env.META_VERIFY_TOKEN;
  if (!verifyToken) {
    logger.warn('[social] META_VERIFY_TOKEN not configured');
    return res.sendStatus(403);
  }

  if (mode === 'subscribe' && token && verifyToken &&
      token.length === verifyToken.length &&
      timingSafeEqual(Buffer.from(token), Buffer.from(verifyToken))) {
    logger.info('[social] Webhook verified');
    return res.status(200).send(challenge);
  }

  res.sendStatus(403);
});

// Signature verification middleware
function verifyMetaSignature(req, res, next) {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('[social] META_APP_SECRET not set in production');
      return res.sendStatus(403);
    }
    return next();
  }

  const signature = req.headers['x-hub-signature-256'];
  if (!signature) {
    logger.warn('[social] Missing x-hub-signature-256');
    return res.sendStatus(403);
  }

  const rawBody = req.rawBody || (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
  const expected = 'sha256=' + createHmac('sha256', appSecret).update(rawBody).digest('hex');

  try {
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      logger.warn('[social] Invalid Meta signature');
      return res.sendStatus(403);
    }
  } catch {
    return res.sendStatus(403);
  }

  next();
}

// POST /webhooks/social — Inbound messages from Messenger + Instagram
router.post('/', verifyMetaSignature, (req, res) => {
  // Always respond 200 fast (Meta retries on non-200)
  res.status(200).send('EVENT_RECEIVED');

  const db = req.app.locals.db;
  if (!db) return;

  try {
    const { object, entry } = req.body || {};

    if (!entry || !Array.isArray(entry)) return;

    for (const e of entry) {
      const messaging = e.messaging || e.messages || [];
      for (const event of messaging) {
        if (!event.message || !event.sender) continue;

        const senderId = event.sender.id;
        const text = event.message?.text || '';
        const isInstagram = object === 'instagram';
        const channel = isInstagram ? 'instagram' : 'messenger';

        if (!text) continue;

        logger.info(`[social] ${channel} message from ${senderId.slice(0, 6)}***`);

        // Process async
        setImmediate(() => {
          handleSocialMessage(db, { senderId, text, channel, pageId: e.id }).catch(err => {
            logger.error(`[social] ${channel} handler error:`, err.message);
          });
        });
      }
    }
  } catch (err) {
    logger.error('[social] Webhook parsing error:', err.message);
  }
});

/**
 * Handle an inbound social message — find client, create lead, trigger brain.
 */
async function handleSocialMessage(db, { senderId, text, channel, pageId }) {
  // Find client by page ID
  const fieldMap = { messenger: 'facebook_page_id', instagram: 'instagram_user_id' };
  const field = fieldMap[channel];
  if (!field) return;

  // Use parameterized query with known-safe column name
  const client = await db.query(
    `SELECT id, business_name, telegram_chat_id, phone_number FROM clients WHERE ${field} = ? AND is_active = 1`,
    [pageId], 'get'
  );

  if (!client) {
    logger.warn(`[social] No client found for ${channel} page ${pageId}`);
    return;
  }

  const { randomUUID } = require('crypto');
  const now = new Date().toISOString();

  // Create/update lead (use senderId as phone-equivalent identifier)
  const socialId = `${channel}:${senderId}`;
  let lead = await db.query(
    'SELECT id FROM leads WHERE client_id = ? AND phone = ?',
    [client.id, socialId], 'get'
  );

  if (!lead) {
    const leadId = randomUUID();
    await db.query(
      `INSERT INTO leads (id, client_id, phone, source, stage, score, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'new', 3, ?, ?)`,
      [leadId, client.id, socialId, channel, now, now], 'run'
    );
    lead = { id: leadId };
  }

  // Store message
  await db.query(
    `INSERT INTO messages (id, client_id, phone, direction, body, channel, created_at)
     VALUES (?, ?, ?, 'inbound', ?, ?, ?)`,
    [randomUUID(), client.id, socialId, text, channel, now], 'run'
  );

  // Rate limit brain calls per sender (max 3 per 5 min to prevent Claude cost spikes)
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const recentBrain = await db.query(
    "SELECT COUNT(*) as c FROM messages WHERE phone = ? AND client_id = ? AND direction = 'inbound' AND created_at >= ?",
    [socialId, client.id, fiveMinAgo], 'get'
  );
  if (recentBrain && recentBrain.c > 3) {
    logger.info(`[social] Rate limited brain call for ${senderId.slice(0, 6)}*** (${recentBrain.c} msgs in 5 min)`);
    return;
  }

  // Trigger brain decision (if available)
  try {
    const { getLeadMemory } = require('../utils/leadMemory');
    const { think } = require('../utils/brain');
    const { executeActions } = require('../utils/actionExecutor');
    const memory = await getLeadMemory(db, socialId, client.id);
    if (memory) {
      const decision = await think('social_message_received', { from: socialId, body: text, channel }, memory, db);
      if (decision?.actions) {
        await executeActions(db, decision.actions, memory);
      }
    }
  } catch (brainErr) {
    logger.warn(`[social] Brain decision failed for ${channel}:`, brainErr.message);
  }

  // Send Telegram notification to owner
  try {
    if (client.telegram_chat_id) {
      const { sendMessage } = require('../utils/telegram');
      const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const icon = channel === 'instagram' ? '&#128247;' : '&#128172;';
      await sendMessage(client.telegram_chat_id,
        `${icon} <b>New ${channel} message</b>\n\n<b>From:</b> ${esc(senderId.slice(0, 8))}...\n<b>Message:</b> ${esc(text.slice(0, 500))}`
      );
    }
  } catch (_) {}
}

module.exports = router;
