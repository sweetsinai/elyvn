const telegram = require('../telegram');
const config = require('../config');
const { logger } = require('../logger');

async function checkReplies(db) {
  try {
    // Only run if IMAP is configured
    if (!process.env.IMAP_USER || !process.env.IMAP_PASS) {
      return;
    }

    const Imap = require('node-imap');
    const { classifyReply } = require('../replyClassifier');
    const { simpleParser } = require('mailparser');

    const imap = new Imap({
      user: process.env.IMAP_USER,
      password: process.env.IMAP_PASS,
      host: config.imap.host,
      port: config.imap.port,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
    });

    const IMAP_CONNECT_TIMEOUT_MS = 30000;

    const connectPromise = new Promise((resolve, reject) => {
      imap.once('ready', resolve);
      imap.once('error', reject);
      imap.connect();
    });

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('IMAP connection timeout after 30s')), IMAP_CONNECT_TIMEOUT_MS)
    );

    await Promise.race([connectPromise, timeoutPromise]);

    await new Promise((resolve, reject) => {
      imap.openBox('INBOX', false, (err) => {
          if (err) { imap.end(); reject(err); return; }

          // Search for unseen messages from the last 24h
          const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
          imap.search(['UNSEEN', ['SINCE', since]], (err, results) => {
            if (err || !results || results.length === 0) {
              imap.end();
              resolve();
              return;
            }

            const f = imap.fetch(results, { bodies: '', markSeen: true });
            const messages = [];

            f.on('message', (msg) => {
              let buffer = '';
              msg.on('body', (stream) => {
                stream.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
              });
              msg.on('end', () => { messages.push(buffer); });
            });

            f.once('end', async () => {
              for (const raw of messages) {
                try {
                  const parsed = await simpleParser(raw);
                  const from = parsed.from?.value?.[0]?.address || '';
                  const subject = parsed.subject || '';
                  const body = parsed.text || '';

                  // Match reply to a sent email by to_email (the address we sent TO)
                  // This handles cases where prospect's reply-from differs from scraped email
                  const sentEmail = db.prepare(`
                    SELECT es.*, p.id as p_id, p.business_name, p.phone as p_phone, p.city as p_city
                    FROM emails_sent es
                    LEFT JOIN prospects p ON p.id = es.prospect_id
                    WHERE es.to_email = ? AND es.reply_text IS NULL AND es.status = 'sent'
                    ORDER BY es.sent_at DESC LIMIT 1
                  `).get(from);

                  if (!sentEmail) {
                    // Fallback: try matching by prospects.email (in case reply came from a different address)
                    const fallbackProspect = db.prepare('SELECT * FROM prospects WHERE email = ?').get(from);
                    if (!fallbackProspect) {
                      logger.info(`[Replies] No matching email found for reply from: ${from}`);
                      continue;
                    }
                    // Try to find the sent email via prospect_id
                    const fallbackEmail = db.prepare(`
                      SELECT * FROM emails_sent WHERE prospect_id = ? AND reply_text IS NULL AND status = 'sent'
                      ORDER BY sent_at DESC LIMIT 1
                    `).get(fallbackProspect.id);
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
                  db.prepare(`
                    UPDATE emails_sent SET reply_text = ?, reply_at = datetime('now'), updated_at = datetime('now')
                    WHERE id = ?
                  `).run(body.substring(0, 2000), sentEmail.id);
                  // NOTE: reply_classification left NULL — auto-classify cron will handle it

                  // Act on reply — update prospect status, notify owner
                  // Classification will be handled by auto-classify cron (which also sends auto-replies)
                  const now = new Date().toISOString();
                  if (prospect) {
                    // Mark prospect as replied so auto-classify picks it up
                    db.prepare("UPDATE prospects SET status = 'replied', updated_at = ? WHERE id = ?").run(now, prospect.id);

                    // Telegram notification for all replies
                    const clients = db.prepare('SELECT telegram_chat_id, calcom_booking_link FROM clients WHERE telegram_chat_id IS NOT NULL').all();
                    for (const c of clients) {
                      telegram.sendMessage(c.telegram_chat_id,
                        `<b>New reply from prospect</b>\n\n<b>${prospect.business_name || from}</b>\n"${result.summary}"\n\nAuto-classification pending.`
                      ).catch(err => logger.warn('[scheduler] Reply Telegram notify failed', err.message));
                    }
                  }
                } catch (parseErr) {
                  logger.error('[Replies] Error processing reply:', parseErr.message);
                }
              }

              imap.end();
              resolve();
            });
          });
        });
    });
  } catch (err) {
    logger.error('[Replies] checkReplies error:', err.message);
    try { imap.end(); } catch (_) {}
  }
}

module.exports = { checkReplies };
