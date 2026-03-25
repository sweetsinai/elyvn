const express = require('express');
const router = express.Router();
const telegram = require('../utils/telegram');

// Verify webhook secret (skip if not configured)
router.use((req, res, next) => {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expectedSecret) {
    const secret = req.headers['x-telegram-bot-api-secret-token'];
    if (secret !== expectedSecret) {
      return res.sendStatus(403);
    }
  }
  next();
});

router.post('/', (req, res) => {
  res.sendStatus(200);

  const db = req.app.locals.db;
  if (!db) {
    console.error('[telegram] No database connection');
    return;
  }
  const update = req.body || {};

  if (update.message) {
    handleCommand(db, update.message).catch(err => console.error('Telegram command error:', err));
  } else if (update.callback_query) {
    handleCallback(db, update.callback_query).catch(err => console.error('Telegram callback error:', err));
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
    await telegram.sendMessage(chatId,
      `Hey ${firstName}! You're connected to <b>${target.business_name || target.name || 'your business'}</b>.\n\n`
      + `Here's what I can do:\n`
      + `/status — Full dashboard (calls, leads, revenue)\n`
      + `/leads — All your leads by stage\n`
      + `/complete +phone — Mark job done\n`
      + `/pause / /resume — Toggle AI\n`
      + `/help — All commands`
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

      await telegram.sendMessage(chatId, msg);
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

        db.transaction(() => {
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

            const scheduledAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
            db.prepare(`
              INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, content_source, scheduled_at, status)
              VALUES (?, ?, ?, 20, 'review_request', ?, 'template', ?, 'scheduled')
            `).run(randomUUID(), lead.id, client.id, reviewMsg, scheduledAt);
          }
        })();

        await telegram.sendMessage(chatId,
          `✅ Done for ${phone}.\nReminders cancelled. Review request in 2h.${reviewLink ? '' : '\n\n⚠️ Set a Google review link: /set review YOUR_LINK'}`
        );
      } catch (completeErr) {
        console.error('[telegram] /complete error:', completeErr.message);
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
          + '/set name My Business — Business name'
        );
        break;
      }

      if (key === 'review') {
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
      } else {
        await telegram.sendMessage(chatId, `Unknown setting "${key}". Try: review, ticket, name`);
      }
      break;
    }

    // ═══════════════════════════════════════════════════════
    // /help — Simple command list
    // ═══════════════════════════════════════════════════════
    case '/help': {
      await telegram.sendMessage(chatId,
        `<b>Commands</b>\n\n`
        + `/status — Full dashboard\n`
        + `/leads — All leads by stage\n`
        + `/calls — Recent calls\n`
        + `/complete +phone — Mark job done\n`
        + `/set — Configure settings\n`
        + `/pause — Pause AI\n`
        + `/resume — Resume AI\n`
        + `/help — This message`
      );
      break;
    }

    default: {
      // For any unrecognized text, show a friendly nudge
      await telegram.sendMessage(chatId, 'Type /status for your dashboard or /help for commands.');
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

  if (data.startsWith('transcript:')) {
    const callId = data.split(':')[1];
    const call = db.prepare('SELECT transcript FROM calls WHERE call_id = ?').get(callId);
    if (call && call.transcript) {
      let transcript = call.transcript;
      if (transcript.length > 3500) {
        transcript = transcript.substring(0, 3500) + '\n\n... (truncated)';
      }
      await telegram.sendMessage(chatId, `<b>Transcript</b>\n\n${transcript}`);
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
