const express = require('express');
const router = express.Router();
const telegram = require('../utils/telegram');

// Verify webhook secret
router.use((req, res, next) => {
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.sendStatus(403);
  }
  next();
});

router.post('/', (req, res) => {
  res.sendStatus(200);

  const db = req.app.locals.db;
  const update = req.body;

  if (update.message) {
    handleCommand(db, update.message).catch(err => console.error('Telegram command error:', err));
  } else if (update.callback_query) {
    handleCallback(db, update.callback_query).catch(err => console.error('Telegram callback error:', err));
  }
});

async function handleCommand(db, message) {
  const chatId = String(message.chat.id);
  const text = (message.text || '').trim();
  const firstName = message.from?.first_name || 'there';

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
      + `/today - Today's schedule\n`
      + `/stats - Last 7 days stats\n`
      + `/calls - Recent calls\n`
      + `/leads - Hot leads\n`
      + `/pause - Pause AI answering\n`
      + `/resume - Resume AI answering\n`
      + `/help - Show commands`
    );
    return;
  }

  // /start without param and no linked client
  if (text === '/start' && !client) {
    await telegram.sendMessage(chatId, 'Use the onboarding link sent to your email to connect your account.');
    return;
  }

  if (!client) {
    await telegram.sendMessage(chatId, 'Your account isn\'t linked yet. Use the onboarding link to get started.');
    return;
  }

  const cmd = text.split(' ')[0].toLowerCase().replace('@', '');

  switch (cmd) {
    case '/start': {
      await telegram.sendMessage(chatId,
        `Welcome back, ${firstName}!\n\n`
        + `/today - Today's schedule\n`
        + `/stats - Last 7 days stats\n`
        + `/calls - Recent calls\n`
        + `/leads - Hot leads\n`
        + `/pause - Pause AI answering\n`
        + `/resume - Resume AI answering\n`
        + `/help - Show commands`
      );
      break;
    }

    case '/today': {
      const today = new Date().toISOString().split('T')[0];
      const bookings = db.prepare(
        `SELECT * FROM calls WHERE client_id = ? AND outcome = 'booked' AND date(created_at) = ? ORDER BY created_at ASC`
      ).all(client.id, today);

      if (bookings.length === 0) {
        await telegram.sendMessage(chatId, 'No bookings for today.');
      } else {
        let msg = `<b>Today's schedule</b> (${bookings.length})\n\n`;
        bookings.forEach((b, i) => {
          const time = b.created_at ? new Date(b.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '';
          msg += `${i + 1}. ${time} - ${b.caller_name || b.caller_phone || 'Unknown'}\n`;
          if (b.summary) msg += `   ${b.summary.substring(0, 80)}\n`;
        });
        await telegram.sendMessage(chatId, msg);
      }
      break;
    }

    case '/stats': {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const calls = db.prepare(
        `SELECT COUNT(*) as total, SUM(CASE WHEN outcome = 'booked' THEN 1 ELSE 0 END) as booked, SUM(CASE WHEN outcome = 'missed' THEN 1 ELSE 0 END) as missed FROM calls WHERE client_id = ? AND created_at >= ?`
      ).get(client.id, since);
      const msgs = db.prepare(
        `SELECT COUNT(*) as total FROM messages WHERE client_id = ? AND created_at >= ?`
      ).get(client.id, since);
      const bookedCount = calls.booked || 0;
      const clientData = db.prepare('SELECT avg_ticket FROM clients WHERE id = ?').get(client.id);
      const rev = { revenue: bookedCount * (clientData?.avg_ticket || 0) };

      await telegram.sendMessage(chatId,
        `<b>Last 7 days</b>\n\n`
        + `Calls: ${calls.total || 0}\n`
        + `Booked: ${calls.booked || 0}\n`
        + `Missed: ${calls.missed || 0}\n`
        + `Messages: ${msgs.total || 0}\n`
        + `Revenue: $${rev.revenue || 0}`
      );
      break;
    }

    case '/calls': {
      const recent = db.prepare(
        `SELECT * FROM calls WHERE client_id = ? ORDER BY created_at DESC LIMIT 5`
      ).all(client.id);

      if (recent.length === 0) {
        await telegram.sendMessage(chatId, 'No calls yet.');
      } else {
        let msg = '<b>Recent calls</b>\n\n';
        recent.forEach((c) => {
          const outcomeEmoji = c.outcome === 'booked' ? '&#9989;'
            : c.outcome === 'missed' ? '&#10060;'
            : c.outcome === 'voicemail' ? '&#128233;'
            : '&#128222;';
          const duration = c.duration ? `${Math.floor(c.duration / 60)}m ${c.duration % 60}s` : '';
          msg += `${outcomeEmoji} ${c.caller_name || c.caller_phone || 'Unknown'}`;
          if (duration) msg += ` (${duration})`;
          if (c.score) msg += ` - Score: ${c.score}/10`;
          msg += `\n`;
          if (c.summary) msg += `  ${c.summary.substring(0, 100)}\n`;
          msg += `\n`;
        });
        await telegram.sendMessage(chatId, msg);
      }
      break;
    }

    case '/leads': {
      const leads = db.prepare(
        `SELECT * FROM leads WHERE client_id = ? AND score >= 7 AND stage NOT IN ('completed', 'lost') ORDER BY score DESC LIMIT 10`
      ).all(client.id);

      if (leads.length === 0) {
        await telegram.sendMessage(chatId, 'No hot leads right now.');
      } else {
        let msg = '<b>Hot leads</b>\n\n';
        leads.forEach((l, i) => {
          const scoreEmoji = l.score >= 9 ? '&#128293;&#128293;' : '&#128293;';
          msg += `${i + 1}. <b>${l.name || 'Unknown'}</b> - ${l.score}/10 ${scoreEmoji}\n`;
          if (l.phone) msg += `   📞 ${l.phone}\n`;
          if (l.summary) msg += `   ${l.summary.substring(0, 80)}\n`;
          msg += `\n`;
        });
        await telegram.sendMessage(chatId, msg);
      }
      break;
    }

    case '/pause': {
      db.prepare('UPDATE clients SET is_active = 0 WHERE id = ?').run(client.id);
      await telegram.sendMessage(chatId, 'AI answering <b>paused</b>. Your calls will ring through to you directly. Use /resume to turn it back on.');
      break;
    }

    case '/resume': {
      db.prepare('UPDATE clients SET is_active = 1 WHERE id = ?').run(client.id);
      await telegram.sendMessage(chatId, 'AI answering <b>resumed</b>. I\'m back on duty.');
      break;
    }

    case '/help': {
      await telegram.sendMessage(chatId,
        `<b>Commands</b>\n\n`
        + `/today - Today's schedule\n`
        + `/stats - Last 7 days stats\n`
        + `/calls - Recent calls\n`
        + `/leads - Hot leads\n`
        + `/pause - Pause AI answering\n`
        + `/resume - Resume AI answering\n`
        + `/help - Show this message`
      );
      break;
    }

    default: {
      await telegram.sendMessage(chatId, 'Type /help to see available commands.');
      break;
    }
  }
}

async function handleCallback(db, callbackQuery) {
  const chatId = String(callbackQuery.message?.chat?.id);
  const data = callbackQuery.data || '';
  const callbackId = callbackQuery.id;

  if (data.startsWith('transcript:')) {
    const callId = data.split(':')[1];
    const call = db.prepare('SELECT transcript FROM calls WHERE id = ?').get(callId);
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
    await telegram.answerCallback(callbackId, 'Noted -- AI reply was good');
  } else if (data.startsWith('msg_takeover:')) {
    const parts = data.split(':');
    const phone = parts[2] || '';
    await telegram.answerCallback(callbackId, "You're handling this one");
    if (chatId) {
      await telegram.sendMessage(chatId, `You're handling this one.${phone ? ` Contact: ${phone}` : ''}`);
    }
  }
}

module.exports = router;
