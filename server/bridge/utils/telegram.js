const { CircuitBreaker } = require('./resilience');
const { AppError } = require('./AppError');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_TIMEOUT_MS = 10000; // 10s timeout for all Telegram API calls

// Circuit breaker for Telegram Bot API — opens after 5 failures in 60s, cools down 30s.
// Fallback: silently swallow — Telegram notifications are non-critical, never block the main flow.
const telegramBreaker = new CircuitBreaker(
  async (url, opts) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS), ...opts });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const { logger } = require('./logger');
      logger.error('[telegram] API error:', JSON.stringify(body));
    }
    return res;
  },
  {
    failureThreshold: 5,
    failureWindow: 60000,
    cooldownPeriod: 30000,
    serviceName: 'Telegram',
    fallback: () => ({ ok: false, fallback: true }),
  }
);

async function sendMessage(chatId, text, options = {}) {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...options,
  };
  const res = await telegramBreaker.call(`${BASE_URL}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.fallback) return { ok: false, description: 'Telegram circuit open' };
  return res.json();
}

async function answerCallback(callbackQueryId, text) {
  const res = await telegramBreaker.call(`${BASE_URL}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text,
    }),
  });
  if (res.fallback) return { ok: false, description: 'Telegram circuit open' };
  return res.json();
}

async function setWebhook(url) {
  const payload = { url };
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret) payload.secret_token = secret;

  const res = await telegramBreaker.call(`${BASE_URL}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const { logger } = require('./logger');
  if (res.fallback) {
    logger.warn('[telegram] setWebhook skipped — circuit open');
    return { ok: false };
  }
  const data = await res.json();
  logger.info(`[telegram] setWebhook ${res.ok ? 'ok' : 'FAILED'}:`, JSON.stringify(data));
  return data;
}

// --- HTML escaping for Telegram HTML parse_mode ---
function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Notification formatters ---

function formatCallNotification(call, client) {
  const outcomeEmoji = call.outcome === 'booked' ? '&#9989;'
    : call.outcome === 'missed' ? '&#10060;'
    : call.outcome === 'voicemail' ? '&#128233;'
    : '&#128222;';
  const scoreEmoji = (call.score || 0) >= 7 ? '&#128293;' : '&#129398;';
  const duration = call.duration ? `${Math.floor(call.duration / 60)}m ${call.duration % 60}s` : 'N/A';
  const phone = call.caller_phone || call.phone || '';

  const text = `${outcomeEmoji} <b>Call ${esc(call.outcome)}</b>\n\n`
    + `<b>Caller:</b> ${esc(call.caller_name || phone)}\n`
    + `<b>Duration:</b> ${duration}\n`
    + `<b>Score:</b> ${call.score || 0}/10 ${scoreEmoji}\n\n`
    + `<b>Summary:</b> ${esc(call.summary || 'No summary')}`;
  const buttons = [];
  buttons.push([
    { text: 'Full transcript', callback_data: `transcript:${call.call_id || call.id}` },
  ]);
  if (phone) {
    buttons.push([
      { text: '💬 Text this caller', callback_data: `reply_prompt:${phone}` },
    ]);
  }

  return { text, buttons };
}

function formatTransferAlert(call, summary, client) {
  const phone = call.caller_phone || call.phone || '';
  const text = `&#128680; <b>TRANSFER -- pick up your phone!</b>\n\n`
    + `<b>Caller:</b> ${esc(call.caller_name || phone)}\n`
    + `<b>Reason:</b> ${esc(summary || 'Caller requested transfer')}\n\n`
    + `Answer now!`;
  return { text };
}

function formatMessageNotification(message, replyText, confidence, client) {
  const confEmoji = confidence === 'high' ? '&#9989;' : confidence === 'medium' ? '&#9888;&#65039;' : '&#10060;';
  const phone = message.from_phone || message.phone || '';
  const text = `&#128172; <b>New message</b>\n\n`
    + `<b>From:</b> ${esc(message.from_name || phone)}\n`
    + `<b>Their message:</b> ${esc(message.body || message.text || '')}\n\n`
    + `<b>AI reply:</b> ${esc(replyText)}\n`
    + `<b>Confidence:</b> ${confEmoji}`;

  const buttons = [[
    { text: 'Good reply', callback_data: `msg_ok:${message.id}` },
    { text: "I'll handle this", callback_data: `msg_takeover:${message.id}:${phone}` },
  ], [
    { text: '💬 Reply to lead', callback_data: `reply_prompt:${phone}` },
  ]];

  return { text, buttons };
}

function formatEscalation(message, aiReply, client) {
  const phone = message.from_phone || message.phone || '';
  const text = `&#9888;&#65039; <b>Needs your input</b>\n\n`
    + `<b>From:</b> ${esc(message.from_name || phone)}\n`
    + `<b>Message:</b> ${esc(message.body || message.text || '')}\n\n`
    + `<b>AI draft (not sent):</b> ${esc(aiReply || 'None')}`;

  const buttons = phone ? [[
    { text: '💬 Reply to lead', callback_data: `reply_prompt:${phone}` },
  ]] : [];

  return { text, buttons };
}

function formatBookingNotification(booking, client) {
  const dt = booking.datetime || booking.date || '';
  const text = `&#128197; <b>New booking</b>\n\n`
    + `<b>Customer:</b> ${esc(booking.customer_name || booking.name || 'Unknown')}\n`
    + `<b>Service:</b> ${esc(booking.service || 'N/A')}\n`
    + `<b>When:</b> ${esc(dt)}\n`
    + `<b>Location:</b> ${esc(booking.location || 'Default')}\n`
    + `<b>Est. revenue:</b> $${booking.estimated_revenue || booking.revenue || 0}`;
  return { text };
}

function formatDailySummary(stats, tomorrow, client) {
  let text = `&#128200; <b>Daily Summary</b>\n\n`
    + `<b>Calls:</b> ${stats.total_calls || 0}\n`
    + `<b>Booked:</b> ${stats.booked || 0}\n`
    + `<b>Missed:</b> ${stats.missed || 0}\n`
    + `<b>Messages:</b> ${stats.messages || 0}\n`
    + `<b>Revenue:</b> $${stats.revenue || 0}\n`;

  if (tomorrow && tomorrow.length > 0) {
    text += `\n<b>Tomorrow's schedule:</b>\n`;
    tomorrow.forEach((item, i) => {
      text += `${i + 1}. ${esc(item.time || '')} - ${esc(item.customer_name || item.name || 'Client')} (${esc(item.service || '')})\n`;
    });
  } else {
    text += `\nNo appointments tomorrow.`;
  }

  return { text };
}

function formatWeeklyReport(report, client) {
  const text = `&#128202; <b>Weekly Report</b>\n\n`
    + `<b>Total calls:</b> ${report.total_calls || 0}\n`
    + `<b>Booked:</b> ${report.booked || 0}\n`
    + `<b>Missed:</b> ${report.missed || 0}\n`
    + `<b>Messages handled:</b> ${report.messages || 0}\n`
    + `<b>Revenue:</b> $${report.revenue || 0}\n`
    + `<b>Missed rate:</b> ${report.missed_rate || 0}%\n\n`
    + `<b>AI Summary:</b> ${esc(report.ai_summary || 'No summary available.')}`;
  return { text };
}

async function sendDocument(chatId, fileContent, filename, caption = '') {
  const blob = new Blob([fileContent], { type: 'text/plain' });
  const formData = new FormData();
  formData.append('chat_id', chatId);
  formData.append('document', blob, filename);
  if (caption) formData.append('caption', caption.substring(0, 1024));
  formData.append('parse_mode', 'HTML');

  const res = await telegramBreaker.call(`${BASE_URL}/sendDocument`, {
    method: 'POST',
    body: formData,
  });
  if (res.fallback) return { ok: false, description: 'Telegram circuit open' };
  const data = await res.json();
  if (!res.ok) {
    const { logger } = require('./logger');
    logger.error('[telegram] sendDocument failed:', JSON.stringify(data));
  }
  return data;
}

// --- Plan-based command menus ---

// Same simple menu for every client — only tested, working features
const CLIENT_COMMANDS = [
  { command: 'status', description: 'Your dashboard — calls, leads, bookings' },
  { command: 'calls', description: 'Recent calls' },
  { command: 'leads', description: 'Your leads' },
  { command: 'today', description: "Today's schedule" },
  { command: 'ask', description: 'Ask AI anything about your business' },
  { command: 'pause', description: 'Pause AI answering' },
  { command: 'resume', description: 'Resume AI answering' },
  { command: 'help', description: 'Show commands' },
];

const PLAN_COMMANDS = {
  starter: CLIENT_COMMANDS,
  pro: CLIENT_COMMANDS,
  premium: CLIENT_COMMANDS,
};

async function setClientCommands(chatId, plan) {
  const commands = PLAN_COMMANDS[plan] || PLAN_COMMANDS.starter;
  try {
    const res = await telegramBreaker.call(`${BASE_URL}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands,
        scope: { type: 'chat', chat_id: chatId },
      }),
    });
    if (res.fallback) return { ok: false, description: 'Telegram circuit open' };
    const data = await res.json();
    if (!res.ok) { const { logger } = require('./logger'); logger.error('[telegram] setMyCommands failed:', JSON.stringify(data)); }
    return data;
  } catch (err) {
    const { logger } = require('./logger'); logger.error('[telegram] setMyCommands error:', err.message);
  }
}

function getOnboardingLink(clientId) {
  const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'ELYVNupdatebot';
  return `https://t.me/${botUsername}?start=${clientId}`;
}

function getHelpText(plan) {
  const commands = PLAN_COMMANDS[plan] || PLAN_COMMANDS.starter;
  return '<b>Commands</b>\n\n' + commands.map(c => `/${c.command} - ${c.description}`).join('\n');
}

module.exports = {
  sendMessage,
  sendDocument,
  answerCallback,
  setWebhook,
  setClientCommands,
  getOnboardingLink,
  getHelpText,
  esc,
  PLAN_COMMANDS,
  formatCallNotification,
  formatTransferAlert,
  formatMessageNotification,
  formatEscalation,
  formatBookingNotification,
  formatDailySummary,
  formatWeeklyReport,
  _telegramBreaker: telegramBreaker,
};
