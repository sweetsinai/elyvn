/**
 * Critical error alerting
 * Sends critical errors to Telegram admin chat
 */

async function alertCriticalError(context, error) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (!token || !chatId) return;
  const msg = `ELYVN Error\n\nContext: ${context}\nError: ${String(error?.message || error).slice(0, 500)}\nTime: ${new Date().toISOString()}`;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: msg }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (_) { /* alerting failure is non-fatal */ }
}

module.exports = { alertCriticalError };
