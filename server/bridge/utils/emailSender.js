const nodemailer = require('nodemailer');
const { randomUUID } = require('crypto');

const DAILY_LIMIT = 30;

function createTransport() {
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = parseInt(process.env.SMTP_PORT || '465', 10);
  const secure = process.env.SMTP_SECURE !== 'false';

  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

async function sendColdEmail(db, prospect, subject, body) {
  const transport = createTransport();
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

    db.prepare(`
      INSERT INTO emails_sent (id, prospect_id, to_email, from_email, subject, body, status, error, sent_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'failed', ?, ?, ?, ?)
    `).run(randomUUID(), prospect.id, prospect.email, fromEmail, subject, body, err.message, now, now, now);

    return { success: false, error: err.message };
  }
}

module.exports = { sendColdEmail, DAILY_LIMIT };
