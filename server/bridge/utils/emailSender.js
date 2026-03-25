const { randomUUID } = require('crypto');
const { getTransporter } = require('./mailer');

const DAILY_LIMIT = parseInt(process.env.EMAIL_DAILY_LIMIT || '300', 10);

async function sendColdEmail(db, prospect, subject, body) {
  const transport = getTransporter();
  if (!transport) {
    console.error('[EmailSender] SMTP not configured');
    return { success: false, error: 'SMTP not configured' };
  }

  if (!prospect.email) {
    return { success: false, error: 'No email address' };
  }

  // Check daily limit
  const todaySent = db.prepare(
    "SELECT COUNT(*) as c FROM emails_sent WHERE status = 'sent' AND date(sent_at) = date('now')"
  ).get();
  if (todaySent.c >= DAILY_LIMIT) {
    console.log('[EmailSender] Daily limit reached');
    return { success: false, error: 'Daily limit reached' };
  }

  const fromEmail = process.env.SMTP_USER;
  const fromName = process.env.SMTP_FROM_NAME || 'ELYVN';

  try {
    const info = await transport.sendMail({
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
    db.prepare(`
      INSERT INTO emails_sent (id, campaign_id, prospect_id, to_email, from_email, subject, body, status, sent_at, created_at, updated_at)
      VALUES (?, NULL, ?, ?, ?, ?, ?, 'sent', ?, ?, ?)
    `).run(randomUUID(), prospect.id, prospect.email, fromEmail, subject, body, now, now, now);

    // Update prospect status
    db.prepare("UPDATE prospects SET status = 'emailed', updated_at = ? WHERE id = ?").run(now, prospect.id);

    console.log(`[EmailSender] Sent to ${prospect.email}: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[EmailSender] Failed to send to ${prospect.email}:`, err.message);

    const now = new Date().toISOString();

    // Detect bounces — mark prospect as bounced so we never email them again
    const isBounce = err.responseCode >= 550 || err.message.includes('rejected') ||
      err.message.includes('not exist') || err.message.includes('invalid') ||
      err.message.includes('undeliverable');

    const status = isBounce ? 'bounced' : 'failed';

    db.prepare(`
      INSERT INTO emails_sent (id, prospect_id, to_email, from_email, subject, body, status, error, sent_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), prospect.id, prospect.email, fromEmail, subject, body, status, err.message, now, now, now);

    if (isBounce) {
      db.prepare("UPDATE prospects SET status = 'bounced', updated_at = ? WHERE id = ?").run(now, prospect.id);
      console.log(`[EmailSender] Bounced: ${prospect.email} — marked as bounced, will not re-email`);
    }

    return { success: false, error: err.message, bounced: isBounce };
  }
}

module.exports = { sendColdEmail, DAILY_LIMIT };
