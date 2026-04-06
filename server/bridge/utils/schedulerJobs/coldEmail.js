const telegram = require('../telegram');
const { OUTREACH_COLD_EMAIL_INTERVAL_MS } = require('../../config/timing');
const { logger } = require('../logger');

async function dailyOutreach(db) {
  try {
    const { generateColdEmail } = require('../emailGenerator');
    const { sendColdEmail, DAILY_LIMIT } = require('../emailSender');

    // Get unsent prospects with email addresses
    const prospects = db.prepare(`
      SELECT * FROM prospects
      WHERE status = 'new' AND email IS NOT NULL AND email != ''
      ORDER BY rating DESC, review_count DESC
      LIMIT ?
    `).all(DAILY_LIMIT);

    if (prospects.length === 0) {
      logger.info('[Outreach] No new prospects to email');
      return;
    }

    logger.info(`[Outreach] Starting daily outreach: ${prospects.length} prospects`);
    let sent = 0, failed = 0;

    const { verifyEmail } = require('../emailVerifier');

    for (const prospect of prospects) {
      try {
        // Verify email before generating + sending
        const verification = await verifyEmail(prospect.email);
        if (!verification.valid) {
          logger.info(`[Outreach] Skipping invalid email ${prospect.email}: ${verification.reason}`);
          db.prepare("UPDATE prospects SET status = 'invalid_email', updated_at = ? WHERE id = ?")
            .run(new Date().toISOString(), prospect.id);
          continue;
        }

        const { subject, body } = await generateColdEmail(prospect);
        const result = await sendColdEmail(db, prospect, subject, body);

        if (result.success) {
          sent++;
        } else {
          failed++;
          if (result.error === 'Daily limit reached') break;
        }

        // Wait 2 minutes between sends
        await new Promise(r => setTimeout(r, OUTREACH_COLD_EMAIL_INTERVAL_MS));
      } catch (err) {
        logger.error(`[Outreach] Error for ${prospect.business_name}:`, err.message);
        failed++;
      }
    }

    // Notify owner via Telegram
    const clients = db.prepare('SELECT telegram_chat_id FROM clients WHERE telegram_chat_id IS NOT NULL LIMIT 1').all();
    for (const c of clients) {
      telegram.sendMessage(c.telegram_chat_id,
        `<b>Daily Outreach Complete</b>\n\nSent: ${sent}\nFailed: ${failed}\nRemaining prospects: ${db.prepare("SELECT COUNT(*) as c FROM prospects WHERE status = 'new' AND email IS NOT NULL").get().c}`
      ).catch(err => logger.warn('[scheduler] Outreach Telegram notify failed', err.message));
    }

    logger.info(`[Outreach] Done: ${sent} sent, ${failed} failed`);
  } catch (err) {
    logger.error('[Outreach] dailyOutreach error:', err);
  }
}

module.exports = { dailyOutreach };
