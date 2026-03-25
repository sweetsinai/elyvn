const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function sendMessage(chatId, text, options = {}) {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...options,
  };
  const res = await fetch(`${BASE_URL}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) console.error('[telegram] sendMessage failed:', JSON.stringify(data));
  return data;
}

async function answerCallback(callbackQueryId, text) {
  const res = await fetch(`${BASE_URL}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text,
    }),
  });
  return res.json();
}

async function setWebhook(url) {
  const payload = { url };
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret) payload.secret_token = secret;

  const res = await fetch(`${BASE_URL}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  console.log(`[telegram] setWebhook ${res.ok ? 'ok' : 'FAILED'}:`, JSON.stringify(data));
  return data;
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

  const text = `${outcomeEmoji} <b>Call ${call.outcome}</b>\n\n`
    + `<b>Caller:</b> ${call.caller_name || phone}\n`
    + `<b>Duration:</b> ${duration}\n`
    + `<b>Score:</b> ${call.score || 0}/10 ${scoreEmoji}\n\n`
    + `<b>Summary:</b> ${call.summary || 'No summary'}`;

  const buttons = [];
  buttons.push([
    { text: 'Full transcript', callback_data: `transcript:${call.call_id || call.id}` },
  ]);

  return { text, buttons };
}

function formatTransferAlert(call, summary, client) {
  const phone = call.caller_phone || call.phone || '';
  const text = `&#128680; <b>TRANSFER -- pick up your phone!</b>\n\n`
    + `<b>Caller:</b> ${call.caller_name || phone}\n`
    + `<b>Reason:</b> ${summary || 'Caller requested transfer'}\n\n`
    + `Answer now!`;
  return { text };
}

function formatMessageNotification(message, replyText, confidence, client) {
  const confEmoji = confidence === 'high' ? '&#9989;' : confidence === 'medium' ? '&#9888;&#65039;' : '&#10060;';
  const phone = message.from_phone || message.phone || '';
  const text = `&#128172; <b>New message</b>\n\n`
    + `<b>From:</b> ${message.from_name || phone}\n`
    + `<b>Their message:</b> ${message.body || message.text || ''}\n\n`
    + `<b>AI reply:</b> ${replyText}\n`
    + `<b>Confidence:</b> ${confEmoji}`;

  const buttons = [[
    { text: 'Good reply', callback_data: `msg_ok:${message.id}` },
    { text: "I'll handle this", callback_data: `msg_takeover:${message.id}:${phone}` },
  ]];

  return { text, buttons };
}

function formatEscalation(message, aiReply, client) {
  const phone = message.from_phone || message.phone || '';
  const text = `&#9888;&#65039; <b>Needs your input</b>\n\n`
    + `<b>From:</b> ${message.from_name || phone}\n`
    + `<b>Message:</b> ${message.body || message.text || ''}\n\n`
    + `<b>AI draft (not sent):</b> ${aiReply || 'None'}`;

  const buttons = [];

  return { text, buttons };
}

function formatBookingNotification(booking, client) {
  const dt = booking.datetime || booking.date || '';
  const text = `&#128197; <b>New booking</b>\n\n`
    + `<b>Customer:</b> ${booking.customer_name || booking.name || 'Unknown'}\n`
    + `<b>Service:</b> ${booking.service || 'N/A'}\n`
    + `<b>When:</b> ${dt}\n`
    + `<b>Location:</b> ${booking.location || 'Default'}\n`
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
      text += `${i + 1}. ${item.time || ''} - ${item.customer_name || item.name || 'Client'} (${item.service || ''})\n`;
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
    + `<b>AI Summary:</b> ${report.ai_summary || 'No summary available.'}`;
  return { text };
}

module.exports = {
  sendMessage,
  answerCallback,
  setWebhook,
  formatCallNotification,
  formatTransferAlert,
  formatMessageNotification,
  formatEscalation,
  formatBookingNotification,
  formatDailySummary,
  formatWeeklyReport,
};
