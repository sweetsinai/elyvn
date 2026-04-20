'use strict';

const telegram = require('../../utils/telegram');
const { isValidURL } = require('../../utils/validate');
const { logger } = require('../../utils/logger');
const { isAsync } = require('../../utils/dbAdapter');
const kbCache = require('../../utils/kbCache');

// HTML-escape user/stored data before sending via Telegram HTML parse mode
function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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

  const client = await db.query('SELECT * FROM clients WHERE telegram_chat_id = ?', [chatId], 'get');

  // /start with linking param
  if (text.startsWith('/start ')) {
    const clientId = text.split(' ')[1];
    const target = await db.query('SELECT * FROM clients WHERE id = ?', [clientId], 'get');
    if (!target) {
      await telegram.sendMessage(chatId, 'Invalid link. Ask your admin for a new onboarding link.');
      return;
    }
    await db.query('UPDATE clients SET telegram_chat_id = ? WHERE id = ?', [chatId, clientId], 'run');
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
      const todayCalls = await db.query(
        `SELECT COUNT(*) as total,
          SUM(CASE WHEN outcome = 'booked' THEN 1 ELSE 0 END) as booked,
          SUM(CASE WHEN outcome = 'missed' THEN 1 ELSE 0 END) as missed
        FROM calls WHERE client_id = ? AND date(created_at) = ?`,
        [client.id, today], 'get'
      );

      const todayMsgs = await db.query(
        `SELECT COUNT(*) as total FROM messages WHERE client_id = ? AND date(created_at) = ?`,
        [client.id, today], 'get'
      );

      // 7-day stats
      const weekCalls = await db.query(
        `SELECT COUNT(*) as total,
          SUM(CASE WHEN outcome = 'booked' THEN 1 ELSE 0 END) as booked
        FROM calls WHERE client_id = ? AND created_at >= ?`,
        [client.id, weekAgo], 'get'
      );

      const weekRevenue = (weekCalls.booked || 0) * (client.avg_ticket || 0);

      // Active leads count
      const leadCounts = await db.query(
        `SELECT stage, COUNT(*) as c FROM leads WHERE client_id = ? AND stage NOT IN ('lost', 'completed') GROUP BY stage`,
        [client.id]
      );
      const totalActive = leadCounts.reduce((sum, l) => sum + l.c, 0);
      const hotCount = leadCounts.find(l => l.stage === 'hot')?.c || 0;
      const bookedCount = leadCounts.find(l => l.stage === 'booked')?.c || 0;

      // Last 3 calls
      const recentCalls = await db.query(
        `SELECT caller_name, caller_phone, outcome, duration, score, summary, created_at
         FROM calls WHERE client_id = ? ORDER BY created_at DESC LIMIT 3`,
        [client.id]
      );

      // Pending jobs
      const pendingJobs = await db.query(
        `SELECT COUNT(*) as c FROM job_queue WHERE status = 'pending'`,
        [], 'get'
      );

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
      const leads = await db.query(
        `SELECT name, phone, score, stage, updated_at
         FROM leads WHERE client_id = ? AND stage NOT IN ('lost', 'completed')
         ORDER BY CASE stage WHEN 'hot' THEN 1 WHEN 'booked' THEN 2 WHEN 'warm' THEN 3
           WHEN 'contacted' THEN 4 WHEN 'new' THEN 5 WHEN 'nurture' THEN 6 ELSE 7 END,
           score DESC LIMIT 20`,
        [client.id]
      );

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
      const recent = await db.query(
        `SELECT * FROM calls WHERE client_id = ? ORDER BY created_at DESC LIMIT 5`,
        [client.id]
      );

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
        const buttons = recent
          .filter(c => c.call_id && c.transcript)
          .map(c => [{
            text: `📄 ${(c.caller_phone || 'Unknown').slice(-4)} — ${timeAgo(c.created_at)}`,
            callback_data: `transcript:${c.call_id}`
          }]);
        await telegram.sendMessage(chatId, msg, {
          reply_markup: buttons.length > 0 ? { inline_keyboard: buttons } : undefined
        });
      }
      break;
    }

    // ═══════════════════════════════════════════════════════
    // /pause & /resume — Toggle AI
    // ═══════════════════════════════════════════════════════
    case '/pause': {
      await db.query('UPDATE clients SET is_active = 0 WHERE id = ?', [client.id], 'run');
      await telegram.sendMessage(chatId, '🔴 AI paused — calls will ring through to you. Use /resume to turn it back on.');
      break;
    }

    case '/resume': {
      await db.query('UPDATE clients SET is_active = 1 WHERE id = ?', [client.id], 'run');
      await telegram.sendMessage(chatId, '🟢 AI resumed — I\'m back on duty.');
      break;
    }

    case '/digest': {
      await db.query("UPDATE clients SET notification_mode = 'digest', updated_at = ? WHERE id = ?", [new Date().toISOString(), client.id], 'run');
      await telegram.sendMessage(chatId, 'Digest mode on. Individual call/SMS alerts silenced — you\'ll only get the daily summary.\n\nUse /alerts to switch back.');
      break;
    }

    case '/alerts': {
      await db.query("UPDATE clients SET notification_mode = 'all', updated_at = ? WHERE id = ?", [new Date().toISOString(), client.id], 'run');
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
        if (isAsync(db)) {
          // Postgres: async transaction
          await db.query('BEGIN', [], 'run');
          try {
            const completeNow = new Date().toISOString();
            await db.query(
              `UPDATE appointments SET status = 'completed', updated_at = ?
               WHERE phone = ? AND client_id = ? AND status IN ('confirmed', 'pending')`,
              [completeNow, phone, client.id], 'run'
            );

            const lead = await db.query('SELECT id, name FROM leads WHERE phone = ? AND client_id = ?', [phone, client.id], 'get');
            if (lead) {
              await db.query(
                "UPDATE followups SET status = 'cancelled' WHERE lead_id = ? AND type = 'reminder' AND status = 'scheduled'",
                [lead.id], 'run'
              );

              await db.query("UPDATE leads SET stage = 'completed', updated_at = ? WHERE id = ?", [completeNow, lead.id], 'run');

              const scheduledAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
              await db.query(`
                INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, content_source, scheduled_at, status)
                VALUES (?, ?, ?, 20, 'review_request', ?, 'template', ?, 'scheduled')
              `, [randomUUID(), lead.id, client.id, reviewMsg, scheduledAt], 'run');

              const referralAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
              const firstName = lead.name ? ' ' + lead.name.split(' ')[0] : '';
              const referralMsg = `Hi${firstName}! If you know anyone who could use our services, we'd love the referral. Thanks again for choosing ${client.business_name || 'us'}!`;
              await db.query(`
                INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, content_source, scheduled_at, status)
                VALUES (?, ?, ?, 21, 'referral_ask', ?, 'template', ?, 'scheduled')
              `, [randomUUID(), lead.id, client.id, referralMsg, referralAt], 'run');

              const rebookAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
              const rebookMsg = `Hi${firstName}! It's been about a month since your last visit to ${client.business_name || 'us'}. Ready to book again?` +
                (client.calcom_booking_link ? ` ${client.calcom_booking_link}` : '');
              await db.query(`
                INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, content_source, scheduled_at, status)
                VALUES (?, ?, ?, 22, 'rebook_nudge', ?, 'template', ?, 'scheduled')
              `, [randomUUID(), lead.id, client.id, rebookMsg, rebookAt], 'run');
            }
            await db.query('COMMIT', [], 'run');
          } catch (txErr) {
            await db.query('ROLLBACK', [], 'run');
            throw txErr;
          }
        } else {
          // SQLite: sync transaction
          const transaction = db.transaction(() => {
            const txNow = new Date().toISOString();
            db.prepare(
              `UPDATE appointments SET status = 'completed', updated_at = ?
               WHERE phone = ? AND client_id = ? AND status IN ('confirmed', 'pending')`
            ).run(txNow, phone, client.id);

            const lead = db.prepare('SELECT id, name FROM leads WHERE phone = ? AND client_id = ?').get(phone, client.id);
            if (lead) {
              db.prepare(
                "UPDATE followups SET status = 'cancelled' WHERE lead_id = ? AND type = 'reminder' AND status = 'scheduled'"
              ).run(lead.id);

              db.prepare("UPDATE leads SET stage = 'completed', updated_at = ? WHERE id = ?").run(txNow, lead.id);

              const scheduledAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
              db.prepare(`
                INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, content_source, scheduled_at, status)
                VALUES (?, ?, ?, 20, 'review_request', ?, 'template', ?, 'scheduled')
              `).run(randomUUID(), lead.id, client.id, reviewMsg, scheduledAt);

              const referralAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
              const firstName = lead.name ? ' ' + lead.name.split(' ')[0] : '';
              const referralMsg = `Hi${firstName}! If you know anyone who could use our services, we'd love the referral. Thanks again for choosing ${client.business_name || 'us'}!`;
              db.prepare(`
                INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, content_source, scheduled_at, status)
                VALUES (?, ?, ?, 21, 'referral_ask', ?, 'template', ?, 'scheduled')
              `).run(randomUUID(), lead.id, client.id, referralMsg, referralAt);

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
        }

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
        await db.query("UPDATE clients SET google_review_link = ?, updated_at = ? WHERE id = ?", [value, new Date().toISOString(), client.id], 'run');
        await telegram.sendMessage(chatId, `✅ Review link updated.`);
      } else if (key === 'ticket') {
        const amount = parseFloat(value);
        if (isNaN(amount)) {
          await telegram.sendMessage(chatId, 'Invalid amount. Usage: /set ticket 150');
          break;
        }
        await db.query("UPDATE clients SET avg_ticket = ?, updated_at = ? WHERE id = ?", [amount, new Date().toISOString(), client.id], 'run');
        await telegram.sendMessage(chatId, `✅ Average ticket set to $${amount}.`);
      } else if (key === 'name') {
        await db.query("UPDATE clients SET business_name = ?, updated_at = ? WHERE id = ?", [value, new Date().toISOString(), client.id], 'run');
        await telegram.sendMessage(chatId, `✅ Business name updated to "${value}".`);
      } else if (key === 'transfer') {
        // Validate phone number format
        const phone = value.replace(/[^\d+]/g, '');
        if (!/^\+?\d{10,15}$/.test(phone)) {
          await telegram.sendMessage(chatId, 'Invalid phone number. Use format: +15551234567');
          break;
        }
        await db.query("UPDATE clients SET transfer_phone = ?, updated_at = ? WHERE id = ?", [phone, new Date().toISOString(), client.id], 'run');
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

      const appts = await db.query(
        `SELECT name, phone, service, datetime, status
         FROM appointments WHERE client_id = ? AND date(datetime) = ?
         ORDER BY datetime ASC`,
        [client.id, today]
      );

      const tomorrowAppts = await db.query(
        `SELECT name, phone, service, datetime, status
         FROM appointments WHERE client_id = ? AND date(datetime) = ?
         ORDER BY datetime ASC`,
        [client.id, tomorrow]
      );

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
      const thisWeek = await db.query(
        `SELECT COUNT(*) as calls,
          SUM(CASE WHEN outcome = 'booked' THEN 1 ELSE 0 END) as booked,
          SUM(CASE WHEN outcome = 'missed' THEN 1 ELSE 0 END) as missed,
          AVG(duration) as avg_duration,
          AVG(score) as avg_score
        FROM calls WHERE client_id = ? AND created_at >= ?`,
        [client.id, weekAgo], 'get'
      );

      // Last week (for comparison)
      const lastWeek = await db.query(
        `SELECT COUNT(*) as calls,
          SUM(CASE WHEN outcome = 'booked' THEN 1 ELSE 0 END) as booked
        FROM calls WHERE client_id = ? AND created_at >= ? AND created_at < ?`,
        [client.id, twoWeeksAgo, weekAgo], 'get'
      );

      const msgs = await db.query(
        `SELECT COUNT(*) as total,
          SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) as inbound,
          SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) as outbound
        FROM messages WHERE client_id = ? AND created_at >= ?`,
        [client.id, weekAgo], 'get'
      );

      const activeLeads = await db.query(
        `SELECT COUNT(*) as c FROM leads WHERE client_id = ? AND stage NOT IN ('lost', 'completed')`,
        [client.id], 'get'
      );

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

    case '/brain': {
      await telegram.sendMessage(chatId, 'This feature is not available. Use /status to see your dashboard.');
      break;
    }

    case '/outreach': {
      await telegram.sendMessage(chatId, 'This feature is not available. Use /status to see your dashboard.');
      break;
    }

    case '/scrape':
    case '/prospects': {
      await telegram.sendMessage(chatId, 'This feature is not available. Use /status to see your dashboard.');
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

      await db.query("UPDATE clients SET google_review_link = ?, updated_at = ? WHERE id = ?", [link, new Date().toISOString(), client.id], 'run');
      await telegram.sendMessage(chatId, '✅ Google review link updated. Customers will get this link after /complete.');
      break;
    }

    // ═══════════════════════════════════════════════════════
    // /help — Dynamic command list based on plan
    // ═══════════════════════════════════════════════════════
    // ═══════════════════════════════════════════════════════
    // /ask — AI answers questions about your business data
    // ═══════════════════════════════════════════════════════
    case '/ask': {
      const question = text.replace(/^\/ask\s*/i, '').trim();
      if (!question) {
        await telegram.sendMessage(chatId, 'Ask me anything about your business!\n\nExamples:\n• /ask how many calls this week?\n• /ask which leads are hot?\n• /ask what was my best day?\n• /ask summarize today');
        break;
      }

      await telegram.sendMessage(chatId, '🤔 Thinking...');

      try {
        const today = new Date().toISOString().split('T')[0];
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

        // Gather business data for context
        const [callsToday, callsWeek, leadsActive, messagesWeek, bookingsWeek] = await Promise.all([
          db.query(`SELECT COUNT(*) as c, SUM(CASE WHEN outcome='booked' THEN 1 ELSE 0 END) as booked FROM calls WHERE client_id = ? AND date(created_at) = ?`, [client.id, today], 'get'),
          db.query(`SELECT COUNT(*) as c, SUM(CASE WHEN outcome='booked' THEN 1 ELSE 0 END) as booked, AVG(score) as avg_score FROM calls WHERE client_id = ? AND created_at >= ?`, [client.id, weekAgo], 'get'),
          db.query(`SELECT stage, COUNT(*) as c FROM leads WHERE client_id = ? AND stage NOT IN ('lost','completed') GROUP BY stage`, [client.id]),
          db.query(`SELECT COUNT(*) as c FROM messages WHERE client_id = ? AND created_at >= ?`, [client.id, weekAgo], 'get'),
          db.query(`SELECT COUNT(*) as c FROM appointments WHERE client_id = ? AND created_at >= ?`, [client.id, weekAgo], 'get'),
        ]);

        const recentCalls = await db.query(
          `SELECT caller_name, caller_phone, outcome, score, summary, created_at FROM calls WHERE client_id = ? ORDER BY created_at DESC LIMIT 5`,
          [client.id]
        );

        const hotLeads = await db.query(
          `SELECT name, phone, stage, score FROM leads WHERE client_id = ? AND stage IN ('hot','warm') ORDER BY score DESC LIMIT 5`,
          [client.id]
        );

        // Load specific knowledge base from MCP folder
        let kbContent = '';
        try {
          const kbData = await kbCache.loadKnowledgeBase(client.id);
          if (kbData) {
            kbContent = `KNOWLEDGE BASE:\n${JSON.stringify(kbData, null, 2)}`;
          }
        } catch (kbErr) {
          logger.warn(`[telegram] Failed to load KB for ${client.id}:`, kbErr.message);
        }

        const context = `BUSINESS: ${esc(client.business_name)}
TODAY: ${callsToday.c || 0} calls (${callsToday.booked || 0} booked)
THIS WEEK: ${callsWeek.c || 0} calls (${callsWeek.booked || 0} booked), avg score ${(callsWeek.avg_score || 0).toFixed(1)}/10
MESSAGES THIS WEEK: ${messagesWeek.c || 0}
BOOKINGS THIS WEEK: ${bookingsWeek.c || 0}
ACTIVE LEADS: ${(leadsActive || []).map(l => `${l.stage}: ${l.c}`).join(', ') || 'none'}
RECENT CALLS:\n${(recentCalls || []).map(c => `  ${c.created_at?.split('T')[0]} — ${c.caller_name || c.caller_phone || '?'} — ${c.outcome} (score: ${c.score || '?'}) ${c.summary ? '— ' + c.summary.substring(0, 80) : ''}`).join('\n') || '  none'}
HOT LEADS:\n${(hotLeads || []).map(l => `  ${l.name || l.phone} — ${l.stage} (score: ${l.score})`).join('\n') || '  none'}
${kbContent}`;

        const Anthropic = require('@anthropic-ai/sdk');
        const anthropic = new Anthropic();
        const response = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 500,
          system: `You are ELYVN's AI assistant helping a business owner understand their data. Answer concisely using the data provided. Use numbers and specifics. If the data doesn't contain what they're asking, say so honestly. Format for Telegram (short paragraphs, no markdown tables).`,
          messages: [{ role: 'user', content: `BUSINESS DATA:\n${context}\n\nQUESTION: ${question}` }],
        });

        const answer = response.content[0]?.text || 'Sorry, I couldn\'t generate an answer.';
        await telegram.sendMessage(chatId, answer);
      } catch (err) {
        logger.error('[telegram] /ask error:', err.message);
        await telegram.sendMessage(chatId, 'Sorry, something went wrong. Try again in a moment.');
      }
      break;
    }

    case '/help': {
      const helpText = telegram.getHelpText(client.plan || 'starter');
      await telegram.sendMessage(chatId, helpText);
      break;
    }

    default: {
      // Smart natural language detection — clients shouldn't need to learn commands
      const lower = text.toLowerCase();
      if (lower.includes('pause') || lower.includes('stop') || lower.includes('turn off')) {
        await db.query('UPDATE clients SET is_active = 0 WHERE id = ?', [client.id], 'run');
        await telegram.sendMessage(chatId, '🔴 AI paused. Calls will ring through to you. Say "resume" or tap below to turn it back on.', {
          reply_markup: { inline_keyboard: [[{ text: '▶️ Resume AI', callback_data: 'quick:resume' }]] }
        });
      } else if (lower.includes('resume') || lower.includes('turn on') || lower.includes('unpause')) {
        await db.query('UPDATE clients SET is_active = 1 WHERE id = ?', [client.id], 'run');
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

module.exports = { handleCommand };
