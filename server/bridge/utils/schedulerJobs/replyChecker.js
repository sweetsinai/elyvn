const telegram = require('../telegram');
const config = require('../config');
const { logger } = require('../logger');

async function checkReplies(db) {
  try {
    // Only run if IMAP is configured
    if (!process.env.IMAP_USER || !process.env.IMAP_PASS) {
      return;
    }

    const { ImapFlow } = require('imapflow');
    const { classifyReply } = require('../replyClassifier');
    const { simpleParser } = require('mailparser');

    const client = new ImapFlow({
      host: config.imap.host,
      port: config.imap.port,
      secure: true,
      auth: {
        user: process.env.IMAP_USER,
        pass: process.env.IMAP_PASS,
      },
      tls: { rejectUnauthorized: false },
      logger: false,
      socketTimeout: 30000,
    });

    // Prevent IMAP socket errors from crashing the entire process
    client.on('error', (err) => {
      logger.warn('[Replies] IMAP connection error (non-fatal):', err.message);
    });

    await client.connect();

    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        // Search for unseen messages from the last 24h
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const uids = await client.search({ unseen: true, since });

        if (!uids || uids.length === 0) {
          return;
        }

        for await (const msg of client.fetch(uids, { source: true, flags: true })) {
          try {
            const raw = msg.source.toString('utf8');
            const parsed = await simpleParser(raw);
            const from = parsed.from?.value?.[0]?.address || '';
            const subject = parsed.subject || '';
            const body = parsed.text || '';

            // Mark as seen
            await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true });

            // Match reply to a sent email by to_email (the address we sent TO)
            // This handles cases where prospect's reply-from differs from scraped email
            const sentEmail = await db.query(`
              SELECT es.*, p.id as p_id, p.business_name, p.phone as p_phone, p.city as p_city
              FROM emails_sent es
              LEFT JOIN prospects p ON p.id = es.prospect_id
              WHERE es.to_email = ? AND es.reply_text IS NULL AND es.status = 'sent'
              ORDER BY es.sent_at DESC LIMIT 1
            `, [from], 'get');

            if (!sentEmail) {
              // Fallback: try matching by prospects.email (in case reply came from a different address)
              const fallbackProspect = await db.query('SELECT * FROM prospects WHERE email = ?', [from], 'get');
              if (!fallbackProspect) {
                logger.info(`[Replies] No matching email found for reply from: ${from}`);
                continue;
              }
              // Try to find the sent email via prospect_id
              const fallbackEmail = await db.query(`
                SELECT * FROM emails_sent WHERE prospect_id = ? AND reply_text IS NULL AND status = 'sent'
                ORDER BY sent_at DESC LIMIT 1
              `, [fallbackProspect.id], 'get');
              if (!fallbackEmail) continue;
              // Patch sentEmail for downstream use
              Object.assign(sentEmail || {}, fallbackEmail, {
                p_id: fallbackProspect.id,
                business_name: fallbackProspect.business_name,
                p_phone: fallbackProspect.phone,
                p_city: fallbackProspect.city,
              });
            }

            const prospect = sentEmail.p_id ? {
              id: sentEmail.p_id,
              business_name: sentEmail.business_name,
              phone: sentEmail.p_phone,
              city: sentEmail.p_city,
            } : null;

            // Classify the reply
            const result = await classifyReply(body, subject);
            logger.info(`[Replies] ${from}: ${result.classification} -- ${result.summary}`);

            // Update the emails_sent record with reply data
            await db.query(`
              UPDATE emails_sent SET reply_text = ?, reply_at = ?, updated_at = ?
              WHERE id = ?
            `, [body.substring(0, 2000), new Date().toISOString(), new Date().toISOString(), sentEmail.id], 'run');
            // NOTE: reply_classification left NULL — auto-classify cron will handle it

            // Act on reply — update prospect status, notify owner
            // Classification will be handled by auto-classify cron (which also sends auto-replies)
            const now = new Date().toISOString();
            if (prospect) {
              // Mark prospect as replied so auto-classify picks it up
              await db.query("UPDATE prospects SET status = 'replied', updated_at = ? WHERE id = ?", [now, prospect.id], 'run');

              // Telegram notification to admin only (outreach is admin-scoped)
              const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
              if (adminChatId) {
                telegram.sendMessage(adminChatId,
                  `<b>New reply from prospect</b>\n\n<b>${prospect.business_name || from}</b>\n"${result.summary}"\n\nAuto-classification pending.`
                ).catch(err => logger.warn('[scheduler] Reply Telegram notify failed', err.message));
              }
            }
          } catch (parseErr) {
            logger.error('[Replies] Error processing reply:', parseErr.message);
          }
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  } catch (err) {
    logger.error('[Replies] checkReplies error:', err.message);
  }
}

module.exports = { checkReplies };
