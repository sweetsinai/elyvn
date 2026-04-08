const { randomUUID } = require('crypto');
const { getTransporter } = require('./mailer');
const config = require('./config');
const { logger } = require('./logger');
const { CircuitBreaker } = require('./resilience');

const DAILY_LIMIT = config.outreach.dailySendLimit;

// Circuit breaker for SMTP sends — opens after 5 failures in 60s, cools down 30s.
// Keeps the outreach pipeline from hammering a misconfigured or unavailable SMTP server.
const smtpBreaker = new CircuitBreaker(
  async (transport, mailOptions) => transport.sendMail(mailOptions),
  {
    failureThreshold: 5,
    failureWindow: 60000,
    cooldownPeriod: 30000,
    serviceName: 'SMTP',
  }
);

async function sendColdEmail(db, prospect, subject, body) {
  const transport = getTransporter();
  if (!transport) {
    logger.error('[EmailSender] SMTP not configured');
    return { success: false, error: 'SMTP not configured' };
  }

  if (!prospect.email) {
    return { success: false, error: 'No email address' };
  }

  // Check daily limit
  const todaySent = await db.query(
    "SELECT COUNT(*) as c FROM emails_sent WHERE status = 'sent' AND date(sent_at) = date('now')",
    [],
    'get'
  );
  if (todaySent.c >= DAILY_LIMIT) {
    logger.info('[EmailSender] Daily limit reached');
    return { success: false, error: 'Daily limit reached' };
  }

  const fromEmail = process.env.SMTP_USER;
  const fromName = process.env.SMTP_FROM_NAME || 'ELYVN';

  try {
    const info = await smtpBreaker.call(transport, {
      from: `"${fromName}" <${fromEmail}>`,
      to: prospect.email,
      subject,
      text: body,
      headers: {
        'List-Unsubscribe': `<mailto:${fromEmail}?subject=unsubscribe>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });

    const now = new Date().toISOString();

    // Log to emails_sent
    await db.query(`
      INSERT INTO emails_sent (id, campaign_id, prospect_id, to_email, from_email, subject, body, status, sent_at, created_at, updated_at)
      VALUES (?, NULL, ?, ?, ?, ?, ?, 'sent', ?, ?, ?)
    `, [randomUUID(), prospect.id, prospect.email, fromEmail, subject, body, now, now, now], 'run');

    // Update prospect status
    await db.query("UPDATE prospects SET status = 'emailed', updated_at = ? WHERE id = ?", [now, prospect.id], 'run');

    logger.info(`[EmailSender] Sent to ${prospect.email}: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    logger.error(`[EmailSender] Failed to send to ${prospect.email}:`, err.message);

    const now = new Date().toISOString();

    // Detect bounces — mark prospect as bounced so we never email them again
    const isBounce = err.responseCode >= 550 || err.message.includes('rejected') ||
      err.message.includes('not exist') || err.message.includes('invalid') ||
      err.message.includes('undeliverable');

    const status = isBounce ? 'bounced' : 'failed';

    await db.query(`
      INSERT INTO emails_sent (id, prospect_id, to_email, from_email, subject, body, status, error, sent_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [randomUUID(), prospect.id, prospect.email, fromEmail, subject, body, status, err.message, now, now, now], 'run');

    if (isBounce) {
      await db.query("UPDATE prospects SET status = 'bounced', updated_at = ? WHERE id = ?", [now, prospect.id], 'run');
      logger.info(`[EmailSender] Bounced: ${prospect.email} — marked as bounced, will not re-email`);
    }

    return { success: false, error: err.message, bounced: isBounce };
  }
}

module.exports = { sendColdEmail, DAILY_LIMIT, _smtpBreaker: smtpBreaker };
