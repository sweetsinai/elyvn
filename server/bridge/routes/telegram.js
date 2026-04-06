const express = require('express');
const router = express.Router();
const telegram = require('../utils/telegram');
const { isValidURL } = require('../utils/validate');
const { logger } = require('../utils/logger');

// HTML-escape user/stored data before sending via Telegram HTML parse mode
function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Rate limiting for Telegram callback queries
const callbackRateLimits = new Map();
const CALLBACK_RATE_LIMIT = 10; // max callbacks per minute per chatId
const CALLBACK_RATE_WINDOW = 60000; // 1 minute

function callbackRateLimit(chatId) {
  const now = Date.now();
  const record = callbackRateLimits.get(chatId);

  if (record) {
    // Clean old entries
    record.timestamps = record.timestamps.filter(t => now - t < CALLBACK_RATE_WINDOW);
    if (record.timestamps.length >= CALLBACK_RATE_LIMIT) {
      logger.warn(`[telegram] Callback rate limit exceeded for chatId ${chatId}`);
      return false; // Rate limited
    }
    record.timestamps.push(now);
  } else {
    callbackRateLimits.set(chatId, { timestamps: [now] });
  }

  // Cleanup old entries every 5 minutes
  if (callbackRateLimits.size > 10000) {
    for (const [k, v] of callbackRateLimits) {
      if (now - Math.max(...v.timestamps) > CALLBACK_RATE_WINDOW) callbackRateLimits.delete(k);
    }
  }

  return true; // Not rate limited
}

// Verify webhook secret (skip if not configured)
router.use((req, res, next) => {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expectedSecret) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('[telegram] TELEGRAM_WEBHOOK_SECRET not configured in production');
      return res.status(500).json({ error: 'Webhook not configured' });
    }
    return next();
  }
  if (expectedSecret) {
    const secret = req.headers['x-telegram-bot-api-secret-token'];
    if (!secret) {
      return res.sendStatus(403);
    }
    // Use timing-safe comparison to prevent timing attacks
    try {
      const crypto = require('crypto');
      if (secret.length === expectedSecret.length) {
        if (!crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(expectedSecret))) {
          return res.sendStatus(403);
        }
      } else {
        // Different lengths — fail securely
        return res.sendStatus(403);
      }
    } catch (err) {
      // Comparison error — fail closed
      return res.sendStatus(403);
    }
  }
  next();
});

router.post('/', (req, res) => {
  res.sendStatus(200);

  const db = req.app.locals.db;
  if (!db) {
    logger.error('[telegram] No database connection');
    return;
  }
  const update = req.body || {};

  if (update.message) {
    handleCommand(db, update.message).catch(err => logger.error('Telegram command error:', err));
  } else if (update.callback_query) {
    handleCallback(db, update.callback_query).catch(err => logger.error('Telegram callback error:', err));
  }
});

// ─── Helper: format duration ───
function fmtDuration(sec) {
  if (!sec) return '';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m${s > 0 ? ` ${s}s` : ''}` : `${s}s`;
}

// ─── Helper: format relative time ───
function timeAgo(isoDate) {
  if (!isoDate) return '';
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ─── Helper: outcome emoji ───
function outcomeEmoji(outcome) {
  return outcome === 'booked' ? '✅'
    : outcome === 'missed' ? '❌'
    : outcome === 'voicemail' ? '📩'
    : outcome === 'transferred' ? '🔀'
    : '📞';
}

// ─── Helper: stage emoji ───
function stageEmoji(stage) {
  return stage === 'hot' ? '🔥'
    : stage === 'warm' ? '🌡'
    : stage === 'booked' ? '✅'
    : stage === 'new' ? '🆕'
    : stage === 'contacted' ? '💬'
    : stage === 'nurture' ? '🌱'
    : stage === 'lost' ? '💀'
    : '📋';
}

async function handleCommand(db, message) {
  if (!message || !message.chat || !message.chat.id) return;
  const chatId = String(message.chat.id);
  const text = (message.text || '').trim();
  const firstName = message.from?.first_name || 'there';

  if (!text) return;

  const client = db.prepare('SELECT * FROM clients WHERE telegram_chat_id = ?').get(chatId);

  // /start with linking param
  if (text.startsWith('/start ')) {
    const clientId = text.split(' ')[1];
    const target = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
    if (!target) {
      await telegram.sendMessage(chatId, 'Invalid link. Ask your admin for a new onboarding link.');
      return;
    }
    db.prepare('UPDATE clients SET telegram_chat_id = ? WHERE id = ?').run(chatId, clientId);
    // Set plan-specific command menu for this client
    await telegram.setClientCommands(chatId, target.plan || 'starter').catch(err =>
      logger.error('[telegram] setClientCommands error:', err.message)
    );

    // ── Friendly welcome — no jargon, no learning curve ──
    await telegram.sendMessage(chatId,
      `Hey ${firstName}! 👋 You're all set.\n\n`
      + `<b>${esc(target.business_name || target.name || 'Your business')}</b> is now connected to ELYVN.\n\n`
      + `Here's what happens next:\n`
      + `• Every call gets answered automatically\n`
      + `• Missed calls get a text back in under 30 seconds\n`
      + `• You get a notification here for every call and message\n\n`
      + `<b>You don't need to do anything.</b> Just watch the notifications come in.\n\n`
      + `When you're ready, tap the menu button (☰) next to the message box to see all your options — or just type /status to see your dashboard.`
    );

    // Send a second message with quick-action buttons
    await telegram.sendMessage(chatId,
      `💡 <b>Quick actions</b>`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '📊 My Dashboard', callback_data: 'quick:status' },
              { text: '📋 My Leads', callback_data: 'quick:leads' },
            ],
            [
              { text: '📅 Today\'s Schedule', callback_data: 'quick:today' },
              { text: '📞 Recent Calls', callback_data: 'quick:calls' },
            ],
            [
              { text: '⏸ Pause AI', callback_data: 'quick:pause' },
              { text: '▶️ Resume AI', callback_data: 'quick:resume' },
            ],
          ]
        }
      }
    );
    return;
  }

  if (text === '/start' && !client) {
    await telegram.sendMessage(chatId, 'Use the onboarding link sent to your email to connect your account.');
    return;
  }

  if (!client) {
    await telegram.sendMessage(chatId, 'Your account isn\'t linked yet. Use the onboarding link to get started.');
    return;
  }

  const cmd = text.split(' ')[0].toLowerCase().replace(/@\w+/, '');

  switch (cmd) {

    // ═══════════════════════════════════════════════════════
    // /status — THE ONE COMMAND that shows everything
    // ═══════════════════════════════════════════════════════
    case '/start':
    case '/status': {
      // Refresh plan-specific command menu on every /start or /status
      telegram.setClientCommands(chatId, client.plan || 'starter').catch(() => {});
      const today = new Date().toISOString().split('T')[0];
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      // Today's stats
      const todayCalls = db.prepare(
        `SELECT COUNT(*) as total,
          SUM(CASE WHEN outcome = 'booked' THEN 1 ELSE 0 END) as booked,
          SUM(CASE WHEN outcome = 'missed' THEN 1 ELSE 0 END) as missed
        FROM calls WHERE client_id = ? AND date(created_at) = ?`
      ).get(client.id, today);

      const todayMsgs = db.prepare(
        `SELECT COUNT(*) as total FROM messages WHERE client_id = ? AND date(created_at) = ?`
      ).get(client.id, today);

      // 7-day stats
      const weekCalls = db.prepare(
        `SELECT COUNT(*) as total,
          SUM(CASE WHEN outcome = 'booked' THEN 1 ELSE 0 END) as booked
        FROM calls WHERE client_id = ? AND created_at >= ?`
      ).get(client.id, weekAgo);

      const weekRevenue = (weekCalls.booked || 0) * (client.avg_ticket || 0);

      // Active leads count
      const leadCounts = db.prepare(
        `SELECT stage, COUNT(*) as c FROM leads WHERE client_id = ? AND stage NOT IN ('lost', 'completed') GROUP BY stage`
      ).all(client.id);
      const totalActive = leadCounts.reduce((sum, l) => sum + l.c, 0);
      const hotCount = leadCounts.find(l => l.stage === 'hot')?.c || 0;
      const bookedCount = leadCounts.find(l => l.stage === 'booked')?.c || 0;

      // Last 3 calls
      const recentCalls = db.prepare(
        `SELECT caller_name, caller_phone, outcome, duration, score, summary, created_at
         FROM calls WHERE client_id = ? ORDER BY created_at DESC LIMIT 3`
      ).all(client.id);

      // Pending jobs
      const pendingJobs = db.prepare(
        `SELECT COUNT(*) as c FROM job_queue WHERE status = 'pending'`
      ).get();

      // Build the message
      let msg = `📊 <b>${client.business_name || 'Dashboard'}</b>\n\n`;

      // Today
      msg += `<b>Today</b>\n`;
      msg += `  Calls: ${todayCalls.total || 0}`;
      if (todayCalls.booked) msg += ` (${todayCalls.booked} booked)`;
      if (todayCalls.missed) msg += ` (${todayCalls.missed} missed)`;
      msg += `\n  Messages: ${todayMsgs.total || 0}\n\n`;

      // 7-day
      msg += `<b>This week</b>\n`;
      msg += `  Calls: ${weekCalls.total || 0} | Booked: ${weekCalls.booked || 0}\n`;
      msg += `  Revenue: $${weekRevenue.toLocaleString()}\n\n`;

      // Leads
      msg += `<b>Leads</b>  (${totalActive} active)\n`;
      if (hotCount > 0) msg += `  🔥 ${hotCount} hot`;
      if (bookedCount > 0) msg += `  ✅ ${bookedCount} booked`;
      if (hotCount > 0 || bookedCount > 0) msg += '\n';
      msg += '\n';

      // Recent calls
      if (recentCalls.length > 0) {
        msg += `<b>Recent calls</b>\n`;
        for (const c of recentCalls) {
          const who = c.caller_name || c.caller_phone || 'Unknown';
          msg += `  ${outcomeEmoji(c.outcome)} ${who}`;
          if (c.duration) msg += ` (${fmtDuration(c.duration)})`;
          if (c.score) msg += ` ${c.score}/10`;
          msg += ` — ${timeAgo(c.created_at)}\n`;
        }
        msg += '\n';
      }

      // AI status
      msg += client.is_active !== 0 ? '🟢 AI is active' : '🔴 AI is paused';
      if (pendingJobs.c > 0) msg += ` | ${pendingJobs.c} jobs queued`;

      // Quick-action buttons — client never needs to type a command
      const statusButtons = [
        [
          { text: '📋 Leads', callback_data: 'quick:leads' },
          { text: '📞 Calls', callback_data: 'quick:calls' },
          { text: '📅 Today', callback_data: 'quick:today' },
        ],
      ];
      if (client.is_active !== 0) {
        statusButtons.push([{ text: '⏸ Pause AI', callback_data: 'quick:pause' }]);
      } else {
        statusButtons.push([{ text: '▶️ Resume AI', callback_data: 'quick:resume' }]);
      }

      await telegram.sendMessage(chatId, msg, {
        reply_markup: { inline_keyboard: statusButtons }
      });
      break;
    }

    // ═══════════════════════════════════════════════════════
    // /leads — All leads grouped by stage
    // ═══════════════════════════════════════════════════════
    case '/leads': {
      const leads = db.prepare(
        `SELECT name, phone, score, stage, updated_at
         FROM leads WHERE client_id = ? AND stage NOT IN ('lost', 'completed')
         ORDER BY
           CASE stage WHEN 'hot' THEN 1 WHEN 'booked' THEN 2 WHEN 'warm' THEN 3
           WHEN 'contacted' THEN 4 WHEN 'new' THEN 5 WHEN 'nurture' THEN 6 ELSE 7 END,
           score DESC
         LIMIT 20`
      ).all(client.id);

      if (leads.length === 0) {
        await telegram.sendMessage(chatId, 'No active leads yet. They\'ll show up after your first call or message.');
        break;
      }

      let msg = `📋 <b>Leads</b> (${leads.length})\n\n`;
      let currentStage = '';
      for (const l of leads) {
        if (l.stage !== currentStage) {
          currentStage = l.stage;
          msg += `\n${stageEmoji(l.stage)} <b>${(l.stage || 'unknown').toUpperCase()}</b>\n`;
        }
        const who = l.name || l.phone || 'Unknown';
        msg += `  ${who}`;
        if (l.score) msg += ` — ${l.score}/10`;
        msg += ` — ${timeAgo(l.updated_at)}\n`;
      }

      await telegram.sendMessage(chatId, msg);
      break;
    }

    // ═══════════════════════════════════════════════════════
    // /calls — Recent calls with transcripts
    // ═══════════════════════════════════════════════════════
    case '/calls': {
      const recent = db.prepare(
        `SELECT * FROM calls WHERE client_id = ? ORDER BY created_at DESC LIMIT 5`
      ).all(client.id);

      if (recent.length === 0) {
        await telegram.sendMessage(chatId, 'No calls yet.');
      } else {
        let msg = '📞 <b>Recent calls</b>\n\n';
        for (const c of recent) {
          const who = c.caller_name || c.caller_phone || 'Unknown';
          msg += `${outcomeEmoji(c.outcome)} <b>${who}</b>`;
          if (c.duration) msg += ` (${fmtDuration(c.duration)})`;
          if (c.score) msg += ` — ${c.score}/10`;
          msg += ` — ${timeAgo(c.created_at)}\n`;
          if (c.summary) msg += `  ${c.summary.substring(0, 120)}\n`;
          msg += '\n';
        }
        await telegram.sendMessage(chatId, msg, {
          reply_markup: recent[0]?.call_id ? {
            inline_keyboard: [[
              { text: '📄 Full transcript', callback_data: `transcript:${recent[0].call_id}` }
            ]]
          } : undefined
        });
      }
      break;
    }

    // ═══════════════════════════════════════════════════════
    // /pause & /resume — Toggle AI
    // ═══════════════════════════════════════════════════════
    case '/pause': {
      db.prepare('UPDATE clients SET is_active = 0 WHERE id = ?').run(client.id);
      await telegram.sendMessage(chatId, '🔴 AI paused — calls will ring through to you. Use /resume to turn it back on.');
      break;
    }

    case '/resume': {
      db.prepare('UPDATE clients SET is_active = 1 WHERE id = ?').run(client.id);
      await telegram.sendMessage(chatId, '🟢 AI resumed — I\'m back on duty.');
      break;
    }

    case '/digest': {
      db.prepare("UPDATE clients SET notification_mode = 'digest', updated_at = datetime('now') WHERE id = ?").run(client.id);
      await telegram.sendMessage(chatId, 'Digest mode on. Individual call/SMS alerts silenced — you\'ll only get the daily summary.\n\nUse /alerts to switch back.');
      break;
    }

    case '/alerts': {
      db.prepare("UPDATE clients SET notification_mode = 'all', updated_at = datetime('now') WHERE id = ?").run(client.id);
      await telegram.sendMessage(chatId, 'Alert mode on. You\'ll get a notification for every call, SMS, and brain action.\n\nUse /digest for daily summaries only.');
      break;
    }

    // ═══════════════════════════════════════════════════════
    // /complete +phone — Mark job done → review request
    // ═══════════════════════════════════════════════════════
    case '/complete': {
      const phone = text.split(' ')[1]?.trim();
      if (!phone) {
        await telegram.sendMessage(chatId, 'Usage: /complete +15551234567');
        break;
      }

      try {
        const { randomUUID } = require('crypto');
        const reviewLink = client.google_review_link || '';
        const reviewMsg = reviewLink
          ? `Thanks for choosing ${client.business_name || 'us'}! If you were happy with the service, a quick review would mean the world to us: ${reviewLink}`
          : `Thanks for choosing ${client.business_name || 'us'}! We appreciate your business.`;

        // Use transaction to ensure atomicity
        const transaction = db.transaction(() => {
          db.prepare(
            `UPDATE appointments SET status = 'completed', updated_at = datetime('now')
             WHERE phone = ? AND client_id = ? AND status IN ('confirmed', 'pending')`
          ).run(phone, client.id);

          const lead = db.prepare('SELECT id, name FROM leads WHERE phone = ? AND client_id = ?').get(phone, client.id);
          if (lead) {
            db.prepare(
              "UPDATE followups SET status = 'cancelled' WHERE lead_id = ? AND type = 'reminder' AND status = 'scheduled'"
            ).run(lead.id);

            db.prepare("UPDATE leads SET stage = 'completed', updated_at = datetime('now') WHERE id = ?").run(lead.id);

            // Review request in 2 hours
            const scheduledAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
            db.prepare(`
              INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, content_source, scheduled_at, status)
              VALUES (?, ?, ?, 20, 'review_request', ?, 'template', ?, 'scheduled')
            `).run(randomUUID(), lead.id, client.id, reviewMsg, scheduledAt);

            // Referral ask in 48 hours
            const referralAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
            const firstName = lead.name ? ' ' + lead.name.split(' ')[0] : '';
            const referralMsg = `Hi${firstName}! If you know anyone who could use our services, we'd love the referral. Thanks again for choosing ${client.business_name || 'us'}!`;
            db.prepare(`
              INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, content_source, scheduled_at, status)
              VALUES (?, ?, ?, 21, 'referral_ask', ?, 'template', ?, 'scheduled')
            `).run(randomUUID(), lead.id, client.id, referralMsg, referralAt);

            // Rebooking nudge in 30 days
            const rebookAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
            const rebookMsg = `Hi${firstName}! It's been about a month since your last visit to ${client.business_name || 'us'}. Ready to book again?` +
              (client.calcom_booking_link ? ` ${client.calcom_booking_link}` : '');
            db.prepare(`
              INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, content_source, scheduled_at, status)
              VALUES (?, ?, ?, 22, 'rebook_nudge', ?, 'template', ?, 'scheduled')
            `).run(randomUUID(), lead.id, client.id, rebookMsg, rebookAt);
          }
        });
        transaction();

        await telegram.sendMessage(chatId,
          `Done for ${phone}.\nReminders cancelled.\nReview request: 2h\nReferral ask: 48h\nRebook nudge: 30d${reviewLink ? '' : '\n\nSet a Google review link: /set review YOUR_LINK'}`
        );
      } catch (completeErr) {
        logger.error('[telegram] /complete error:', completeErr.message);
        await telegram.sendMessage(chatId, 'Error marking job complete. Try again.');
      }
      break;
    }

    // ═══════════════════════════════════════════════════════
    // /set key value — Configure settings
    // ═══════════════════════════════════════════════════════
    case '/set': {
      const parts = text.split(' ').slice(1);
      const key = (parts[0] || '').toLowerCase();
      const value = parts.slice(1).join(' ').trim();

      if (!key || !value) {
        await telegram.sendMessage(chatId,
          '<b>Settings</b>\n\n'
          + '/set review https://g.page/... — Google review link\n'
          + '/set ticket 150 — Average ticket price\n'
          + '/set name My Business — Business name\n'
          + '/set transfer +15551234567 — Call transfer number'
        );
        break;
      }

      if (key === 'review') {
        if (!isValidURL(value)) {
          await telegram.sendMessage(chatId, 'Invalid URL. Must start with https:// or http://');
          break;
        }
        db.prepare('UPDATE clients SET google_review_link = ?, updated_at = datetime(\'now\') WHERE id = ?').run(value, client.id);
        await telegram.sendMessage(chatId, `✅ Review link updated.`);
      } else if (key === 'ticket') {
        const amount = parseFloat(value);
        if (isNaN(amount)) {
          await telegram.sendMessage(chatId, 'Invalid amount. Usage: /set ticket 150');
          break;
        }
        db.prepare('UPDATE clients SET avg_ticket = ?, updated_at = datetime(\'now\') WHERE id = ?').run(amount, client.id);
        await telegram.sendMessage(chatId, `✅ Average ticket set to $${amount}.`);
      } else if (key === 'name') {
        db.prepare('UPDATE clients SET business_name = ?, updated_at = datetime(\'now\') WHERE id = ?').run(value, client.id);
        await telegram.sendMessage(chatId, `✅ Business name updated to "${value}".`);
      } else if (key === 'transfer') {
        // Validate phone number format
        const phone = value.replace(/[^\d+]/g, '');
        if (!/^\+?\d{10,15}$/.test(phone)) {
          await telegram.sendMessage(chatId, 'Invalid phone number. Use format: +15551234567');
          break;
        }
        db.prepare('UPDATE clients SET transfer_phone = ?, updated_at = datetime(\'now\') WHERE id = ?').run(phone, client.id);
        await telegram.sendMessage(chatId,
          `✅ Transfer number set to ${phone}.\n\n`
          + `When a caller says "transfer" or presses *, the AI will forward the call to this number.\n\n`
          + `<b>Note:</b> You also need to set this number in your Retell agent's transfer settings for live call forwarding.`
        );
      } else {
        await telegram.sendMessage(chatId, `Unknown setting "${key}". Try: review, ticket, name, transfer`);
      }
      break;
    }

    // ═══════════════════════════════════════════════════════
    // /today — Today's schedule (appointments)
    // ═══════════════════════════════════════════════════════
    case '/today': {
      const today = new Date().toISOString().split('T')[0];
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      const appts = db.prepare(
        `SELECT name, phone, service, datetime, status
         FROM appointments WHERE client_id = ? AND date(datetime) = ?
         ORDER BY datetime ASC`
      ).all(client.id, today);

      const tomorrowAppts = db.prepare(
        `SELECT name, phone, service, datetime, status
         FROM appointments WHERE client_id = ? AND date(datetime) = ?
         ORDER BY datetime ASC`
      ).all(client.id, tomorrow);

      if (appts.length === 0 && tomorrowAppts.length === 0) {
        await telegram.sendMessage(chatId, '📅 No appointments scheduled for today or tomorrow.');
        break;
      }

      let msg = `📅 <b>Schedule</b>\n\n`;

      if (appts.length > 0) {
        msg += `<b>Today (${today})</b>\n`;
        for (const a of appts) {
          const time = a.datetime ? new Date(a.datetime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '—';
          const statusIcon = a.status === 'completed' ? '✅' : a.status === 'cancelled' ? '❌' : '🕐';
          msg += `  ${statusIcon} ${time} — ${a.name || a.phone || 'Client'}`;
          if (a.service) msg += ` (${a.service})`;
          msg += '\n';
        }
        msg += '\n';
      }

      if (tomorrowAppts.length > 0) {
        msg += `<b>Tomorrow (${tomorrow})</b>\n`;
        for (const a of tomorrowAppts) {
          const time = a.datetime ? new Date(a.datetime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '—';
          msg += `  🕐 ${time} — ${a.name || a.phone || 'Client'}`;
          if (a.service) msg += ` (${a.service})`;
          msg += '\n';
        }
      }

      await telegram.sendMessage(chatId, msg);
      break;
    }

    // ═══════════════════════════════════════════════════════
    // /stats — 7-day performance overview
    // ═══════════════════════════════════════════════════════
    case '/stats': {
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

      // This week
      const thisWeek = db.prepare(
        `SELECT COUNT(*) as calls,
          SUM(CASE WHEN outcome = 'booked' THEN 1 ELSE 0 END) as booked,
          SUM(CASE WHEN outcome = 'missed' THEN 1 ELSE 0 END) as missed,
          AVG(duration) as avg_duration,
          AVG(score) as avg_score
        FROM calls WHERE client_id = ? AND created_at >= ?`
      ).get(client.id, weekAgo);

      // Last week (for comparison)
      const lastWeek = db.prepare(
        `SELECT COUNT(*) as calls,
          SUM(CASE WHEN outcome = 'booked' THEN 1 ELSE 0 END) as booked
        FROM calls WHERE client_id = ? AND created_at >= ? AND created_at < ?`
      ).get(client.id, twoWeeksAgo, weekAgo);

      const msgs = db.prepare(
        `SELECT COUNT(*) as total,
          SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) as inbound,
          SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) as outbound
        FROM messages WHERE client_id = ? AND created_at >= ?`
      ).get(client.id, weekAgo);

      const activeLeads = db.prepare(
        `SELECT COUNT(*) as c FROM leads WHERE client_id = ? AND stage NOT IN ('lost', 'completed')`
      ).get(client.id);

      const revenue = (thisWeek.booked || 0) * (client.avg_ticket || 0);
      const lastRevenue = (lastWeek.booked || 0) * (client.avg_ticket || 0);
      const revDelta = lastRevenue > 0 ? Math.round(((revenue - lastRevenue) / lastRevenue) * 100) : 0;
      const revArrow = revDelta > 0 ? `↑${revDelta}%` : revDelta < 0 ? `↓${Math.abs(revDelta)}%` : '—';

      let msg = `📊 <b>7-Day Performance</b>\n\n`;
      msg += `<b>Calls</b>\n`;
      msg += `  Total: ${thisWeek.calls || 0}`;
      if (lastWeek.calls) msg += ` (prev: ${lastWeek.calls})`;
      msg += `\n  Booked: ${thisWeek.booked || 0} | Missed: ${thisWeek.missed || 0}\n`;
      if (thisWeek.avg_score) msg += `  Avg score: ${Math.round(thisWeek.avg_score * 10) / 10}/10\n`;
      if (thisWeek.avg_duration) msg += `  Avg duration: ${fmtDuration(Math.round(thisWeek.avg_duration))}\n`;
      msg += '\n';

      msg += `<b>Messages</b>\n`;
      msg += `  Total: ${msgs.total || 0} (${msgs.inbound || 0} in / ${msgs.outbound || 0} out)\n\n`;

      msg += `<b>Revenue</b>\n`;
      msg += `  Est: $${revenue.toLocaleString()} ${revArrow}\n`;
      msg += `  Active leads: ${activeLeads.c || 0}\n`;

      await telegram.sendMessage(chatId, msg);
      break;
    }

    // ═══════════════════════════════════════════════════════
    // /brain — AI Brain activity feed
    // ═══════════════════════════════════════════════════════
    case '/brain': {
      if (!client.plan || client.plan === 'starter') {
        await telegram.sendMessage(chatId, '🧠 AI Brain is available on Growth and Scale plans. Upgrade to unlock autonomous AI decisions.');
        break;
      }

      const decisions = db.prepare(
        `SELECT details, created_at FROM audit_log
         WHERE client_id = ? AND action = 'brain_decision'
         ORDER BY created_at DESC LIMIT 10`
      ).all(client.id);

      if (decisions.length === 0) {
        await telegram.sendMessage(chatId, '🧠 No brain activity yet. The AI Brain activates after your first call or message.');
        break;
      }

      let msg = `🧠 <b>AI Brain — Last 10 Decisions</b>\n\n`;
      for (const d of decisions) {
        try {
          const details = typeof d.details === 'string' ? JSON.parse(d.details) : d.details;
          const action = details.action || details.type || 'decision';
          const reason = details.reason || details.reasoning || '';
          const lead = details.lead_name || details.phone || '';
          const actionEmoji = action === 'send_sms' ? '💬'
            : action === 'schedule_followup' ? '⏰'
            : action === 'update_lead_stage' ? '📊'
            : action === 'notify_owner' ? '🔔'
            : action === 'book_appointment' ? '📅'
            : action === 'no_action' ? '⏸'
            : '🤖';

          msg += `${actionEmoji} <b>${esc(action.replace(/_/g, ' '))}</b>`;
          if (lead) msg += ` — ${esc(lead)}`;
          msg += ` — ${timeAgo(d.created_at)}\n`;
          if (reason) msg += `  <i>${esc(reason.substring(0, 100))}</i>\n`;
        } catch (e) {
          msg += `🤖 Decision — ${timeAgo(d.created_at)}\n`;
        }
      }

      // Brain stats
      const brainCount = db.prepare(
        `SELECT COUNT(*) as c FROM audit_log WHERE client_id = ? AND action = 'brain_decision' AND created_at >= datetime('now', '-7 days')`
      ).get(client.id);
      msg += `\n<b>7-day total:</b> ${brainCount.c || 0} decisions`;

      await telegram.sendMessage(chatId, msg);
      break;
    }

    // ═══════════════════════════════════════════════════════
    // /outreach — Outreach campaign stats (7 days)
    // ═══════════════════════════════════════════════════════
    case '/outreach': {
      if (!client.plan || client.plan !== 'scale') {
        await telegram.sendMessage(chatId, '📧 Outreach is available on the Scale plan. Upgrade to unlock automated prospecting.');
        break;
      }

      const campaigns = db.prepare(
        `SELECT id, name, industry, city, total_prospects, total_sent, total_replied, total_positive, total_booked, status, created_at
         FROM campaigns WHERE client_id = ? ORDER BY created_at DESC LIMIT 5`
      ).all(client.id);

      if (campaigns.length === 0) {
        await telegram.sendMessage(chatId, '📧 No campaigns yet. Use /scrape industry city to find prospects.');
        break;
      }

      let msg = `📧 <b>Outreach Campaigns</b>\n\n`;
      for (const c of campaigns) {
        const replyRate = c.total_sent > 0 ? Math.round((c.total_replied / c.total_sent) * 100) : 0;
        const statusIcon = c.status === 'active' ? '🟢' : c.status === 'draft' ? '📝' : '⏸';
        msg += `${statusIcon} <b>${esc(c.name || `${c.industry} — ${c.city}`)}</b>\n`;
        msg += `  Sent: ${c.total_sent || 0} | Replies: ${c.total_replied || 0} (${replyRate}%)\n`;
        msg += `  Positive: ${c.total_positive || 0} | Booked: ${c.total_booked || 0}\n`;
        msg += `  ${timeAgo(c.created_at)}\n\n`;
      }

      // Overall stats
      const totals = db.prepare(
        `SELECT SUM(total_sent) as sent, SUM(total_replied) as replied, SUM(total_booked) as booked
         FROM campaigns WHERE client_id = ?`
      ).get(client.id);
      msg += `<b>Overall:</b> ${totals.sent || 0} sent → ${totals.replied || 0} replies → ${totals.booked || 0} booked`;

      await telegram.sendMessage(chatId, msg);
      break;
    }

    // ═══════════════════════════════════════════════════════
    // /scrape industry city — Find prospects via Google Maps
    // ═══════════════════════════════════════════════════════
    case '/scrape': {
      if (!client.plan || client.plan !== 'scale') {
        await telegram.sendMessage(chatId, '🔍 Prospect finder is available on the Scale plan.');
        break;
      }

      const args = text.split(' ').slice(1);
      if (args.length < 2) {
        await telegram.sendMessage(chatId, 'Usage: /scrape HVAC Phoenix\n\nSearches Google Maps for businesses in that industry and city.');
        break;
      }

      // Sanitize inputs — only allow alphanumeric, spaces, hyphens
      const industry = args.slice(0, -1).join(' ').replace(/[^a-zA-Z0-9 \-]/g, '').substring(0, 50);
      const city = args[args.length - 1].replace(/[^a-zA-Z0-9 \-]/g, '').substring(0, 50);
      if (!industry || !city) {
        await telegram.sendMessage(chatId, 'Invalid input. Use letters only. Example: /scrape HVAC Phoenix');
        break;
      }

      await telegram.sendMessage(chatId, `🔍 Searching for <b>${industry}</b> businesses in <b>${city}</b>...\n\nThis takes 30-60 seconds.`);

      // Trigger the scrape via internal API
      try {
        const http = require('http');
        const postData = JSON.stringify({ industry, city, client_id: client.id });
        const options = {
          hostname: 'localhost',
          port: process.env.PORT || 3000,
          path: '/outreach/scrape',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
            'x-api-key': process.env.ELYVN_API_KEY || '',
          },
        };

        const req = http.request(options, (res) => {
          let body = '';
          res.on('data', (chunk) => body += chunk);
          res.on('end', () => {
            try {
              const result = JSON.parse(body);
              if (result.prospects && result.prospects.length > 0) {
                let msg = `✅ Found <b>${result.prospects.length}</b> prospects!\n\n`;
                const top5 = result.prospects.slice(0, 5);
                for (const p of top5) {
                  msg += `  • ${esc(p.business_name || p.name)}`;
                  if (p.rating) msg += ` ⭐${esc(String(p.rating))}`;
                  if (p.phone) msg += ` — ${esc(p.phone)}`;
                  msg += '\n';
                }
                if (result.prospects.length > 5) msg += `  ... and ${result.prospects.length - 5} more\n`;
                msg += '\nUse /prospects to see top 10.';
                telegram.sendMessage(chatId, msg);
              } else {
                telegram.sendMessage(chatId, `No prospects found for ${industry} in ${city}. Try a different search.`);
              }
            } catch (e) {
              telegram.sendMessage(chatId, 'Scrape completed but couldn\'t parse results. Check dashboard.');
            }
          });
        });
        req.on('error', () => {
          telegram.sendMessage(chatId, 'Scrape failed. Check that your Google Maps API key is configured.');
        });
        req.setTimeout(90000);
        req.write(postData);
        req.end();
      } catch (err) {
        logger.error('[telegram] /scrape error:', err.message);
        await telegram.sendMessage(chatId, 'Error starting scrape. Try again later.');
      }
      break;
    }

    // ═══════════════════════════════════════════════════════
    // /prospects — Top 10 recent prospects
    // ═══════════════════════════════════════════════════════
    case '/prospects': {
      if (!client.plan || client.plan !== 'scale') {
        await telegram.sendMessage(chatId, '🔍 Prospect finder is available on the Scale plan.');
        break;
      }

      const prospects = db.prepare(
        `SELECT p.business_name, p.phone, p.email, p.industry, p.city, p.rating, p.review_count, p.status
         FROM prospects p
         JOIN campaign_prospects cp ON cp.prospect_id = p.id
         JOIN campaigns c ON c.id = cp.campaign_id AND c.client_id = ?
         ORDER BY p.rating DESC, p.review_count DESC
         LIMIT 10`
      ).all(client.id);

      if (prospects.length === 0) {
        await telegram.sendMessage(chatId, '🔍 No prospects yet. Use /scrape industry city to find some.');
        break;
      }

      let msg = `🔍 <b>Top 10 Prospects</b>\n\n`;
      for (let i = 0; i < prospects.length; i++) {
        const p = prospects[i];
        const statusIcon = p.status === 'scraped' ? '🆕' : p.status === 'bounced' ? '❌' : '📧';
        msg += `${i + 1}. ${statusIcon} <b>${esc(p.business_name || 'Unknown')}</b>`;
        if (p.rating) msg += ` ⭐${esc(String(p.rating))}`;
        if (p.review_count) msg += ` (${esc(String(p.review_count))} reviews)`;
        msg += '\n';
        if (p.phone) msg += `   📞 ${esc(p.phone)}`;
        if (p.email) msg += ` | 📧 ${esc(p.email)}`;
        msg += '\n';
      }

      await telegram.sendMessage(chatId, msg);
      break;
    }

    // ═══════════════════════════════════════════════════════
    // /reviewlink — Set/view Google review link
    // ═══════════════════════════════════════════════════════
    case '/reviewlink': {
      const link = text.split(' ').slice(1).join(' ').trim();
      if (!link) {
        const current = client.google_review_link;
        if (current) {
          await telegram.sendMessage(chatId, `📎 Current review link:\n${current}\n\nTo change: /reviewlink https://g.page/...`);
        } else {
          await telegram.sendMessage(chatId, '📎 No review link set.\n\nUsage: /reviewlink https://g.page/your-business');
        }
        break;
      }

      if (!isValidURL(link)) {
        await telegram.sendMessage(chatId, 'Invalid URL. Must start with https:// or http://');
        break;
      }

      db.prepare('UPDATE clients SET google_review_link = ?, updated_at = datetime(\'now\') WHERE id = ?').run(link, client.id);
      await telegram.sendMessage(chatId, '✅ Google review link updated. Customers will get this link after /complete.');
      break;
    }

    // ═══════════════════════════════════════════════════════
    // /help — Dynamic command list based on plan
    // ═══════════════════════════════════════════════════════
    case '/help': {
      const helpText = telegram.getHelpText(client.plan || 'starter');
      await telegram.sendMessage(chatId, helpText);
      break;
    }

    default: {
      // Smart natural language detection — clients shouldn't need to learn commands
      const lower = text.toLowerCase();
      if (lower.includes('pause') || lower.includes('stop') || lower.includes('turn off')) {
        db.prepare('UPDATE clients SET is_active = 0 WHERE id = ?').run(client.id);
        await telegram.sendMessage(chatId, '🔴 AI paused. Calls will ring through to you. Say "resume" or tap below to turn it back on.', {
          reply_markup: { inline_keyboard: [[{ text: '▶️ Resume AI', callback_data: 'quick:resume' }]] }
        });
      } else if (lower.includes('resume') || lower.includes('turn on') || lower.includes('unpause')) {
        db.prepare('UPDATE clients SET is_active = 1 WHERE id = ?').run(client.id);
        await telegram.sendMessage(chatId, '🟢 AI is back on. I\'m handling calls again.');
      } else if (lower.includes('lead') || lower.includes('prospect')) {
        // Redirect to leads
        const fakeMsg = { chat: { id: chatId }, from: { first_name: firstName }, text: '/leads' };
        await handleCommand(db, fakeMsg);
      } else if (lower.includes('call') || lower.includes('phone')) {
        const fakeMsg = { chat: { id: chatId }, from: { first_name: firstName }, text: '/calls' };
        await handleCommand(db, fakeMsg);
      } else if (lower.includes('schedule') || lower.includes('appointment') || lower.includes('today') || lower.includes('tomorrow')) {
        const fakeMsg = { chat: { id: chatId }, from: { first_name: firstName }, text: '/today' };
        await handleCommand(db, fakeMsg);
      } else {
        // Friendly fallback with tap-to-action buttons
        await telegram.sendMessage(chatId,
          `I didn't catch that. Here's what you can do:`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '📊 Dashboard', callback_data: 'quick:status' },
                  { text: '📋 Leads', callback_data: 'quick:leads' },
                ],
                [
                  { text: '📞 Calls', callback_data: 'quick:calls' },
                  { text: '📅 Schedule', callback_data: 'quick:today' },
                ],
              ]
            }
          }
        );
      }
      break;
    }
  }
}

async function handleCallback(db, callbackQuery) {
  if (!callbackQuery) return;
  const chatId = String(callbackQuery.message?.chat?.id || '');
  const data = callbackQuery.data || '';
  const callbackId = callbackQuery.id;

  if (!chatId || !data) return;

  // Rate limit callback queries
  if (!callbackRateLimit(chatId)) {
    logger.warn(`[telegram] Callback rate limited for chatId ${chatId}`);
    return;
  }

  // ── Quick-action buttons (no typing needed) ──
  if (data.startsWith('quick:')) {
    const action = data.split(':')[1];
    await telegram.answerCallback(callbackId, 'Loading...');
    // Simulate the command by building a fake message and running handleCommand
    const fakeMessage = {
      chat: { id: chatId },
      from: callbackQuery.from,
      text: `/${action}`,
    };
    await handleCommand(db, fakeMessage).catch(err =>
      logger.error('[telegram] quick-action error:', err)
    );
    return;
  }

  if (data.startsWith('transcript:')) {
    const callId = data.split(':')[1];
    const call = db.prepare('SELECT transcript, caller_phone, created_at, summary FROM calls WHERE call_id = ?').get(callId);
    if (call && call.transcript) {
      const transcript = call.transcript;
      if (transcript.length > 3500) {
        // Send as downloadable .txt file for long transcripts
        const header = [
          `ELYVN Call Transcript`,
          `Call ID: ${callId}`,
          `Caller: ${call.caller_phone || 'unknown'}`,
          `Date: ${call.created_at || 'unknown'}`,
          call.summary ? `Summary: ${call.summary}` : '',
          '─'.repeat(50),
          '',
        ].filter(Boolean).join('\n');
        const filename = `transcript-${callId.substring(0, 8)}.txt`;
        await telegram.sendDocument(chatId, header + transcript, filename, `<b>Full transcript</b> (${transcript.length} chars)`);
      } else {
        await telegram.sendMessage(chatId, `<b>Transcript</b>\n\n${transcript}`);
      }
    } else {
      await telegram.sendMessage(chatId, 'Transcript not available.');
    }
    await telegram.answerCallback(callbackId, 'Transcript sent');
  } else if (data.startsWith('msg_ok:')) {
    await telegram.answerCallback(callbackId, 'Noted — AI reply was good');
  } else if (data.startsWith('msg_takeover:')) {
    const parts = data.split(':');
    const phone = parts[2] || '';
    await telegram.answerCallback(callbackId, "You're handling this one");
    if (chatId) {
      await telegram.sendMessage(chatId, `You're handling this one.${phone ? ` Contact: ${phone}` : ''}`);
    }
  } else if (data.startsWith('cancel_speed:')) {
    const leadId = data.split(':')[1];
    try {
      const { cancelJobs } = require('../utils/jobQueue');
      const cancelled = cancelJobs(db, { payloadContains: leadId });
      db.prepare("UPDATE followups SET status = 'cancelled' WHERE lead_id = ? AND status = 'scheduled'").run(leadId);
      await telegram.answerCallback(callbackId, `Cancelled ${cancelled} jobs`);
      await telegram.sendMessage(chatId, `⏹ Speed sequence cancelled for lead.`);
    } catch (err) {
      await telegram.answerCallback(callbackId, 'Error cancelling');
    }
  }
}

module.exports = router;
