const telegram = require('./telegram');

function sendDailySummaries(db) {
  const clients = db.prepare(
    'SELECT * FROM clients WHERE telegram_chat_id IS NOT NULL AND is_active = 1'
  ).all();

  const today = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  for (const client of clients) {
    const calls = db.prepare(
      `SELECT COUNT(*) as total,
        SUM(CASE WHEN outcome = 'booked' THEN 1 ELSE 0 END) as booked,
        SUM(CASE WHEN outcome = 'missed' THEN 1 ELSE 0 END) as missed
      FROM calls WHERE client_id = ? AND date(created_at) = ?`
    ).get(client.id, today);

    const msgs = db.prepare(
      `SELECT COUNT(*) as total FROM messages WHERE client_id = ? AND date(created_at) = ?`
    ).get(client.id, today);

    const rev = db.prepare(
      `SELECT COALESCE(COUNT(*) * ?, 0) as revenue FROM calls WHERE client_id = ? AND outcome = 'booked' AND date(created_at) = ?`
    ).get(client.avg_ticket || 0, client.id, today);

    const tomorrowSchedule = db.prepare(
      `SELECT * FROM calls WHERE client_id = ? AND outcome = 'booked' AND date(created_at) = ? ORDER BY created_at ASC`
    ).all(client.id, tomorrow);

    const stats = {
      total_calls: calls.total || 0,
      booked: calls.booked || 0,
      missed: calls.missed || 0,
      messages: msgs.total || 0,
      revenue: rev.revenue || 0,
    };

    const formatted = telegram.formatDailySummary(stats, tomorrowSchedule, client);
    telegram.sendMessage(client.telegram_chat_id, formatted.text).catch(err =>
      console.error(`Daily summary failed for client ${client.id}:`, err)
    );
  }
}

function sendWeeklyReports(db) {
  const clients = db.prepare(
    'SELECT * FROM clients WHERE telegram_chat_id IS NOT NULL AND is_active = 1'
  ).all();

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  for (const client of clients) {
    const calls = db.prepare(
      `SELECT COUNT(*) as total,
        SUM(CASE WHEN outcome = 'booked' THEN 1 ELSE 0 END) as booked,
        SUM(CASE WHEN outcome = 'missed' THEN 1 ELSE 0 END) as missed
      FROM calls WHERE client_id = ? AND created_at >= ?`
    ).get(client.id, since);

    const msgs = db.prepare(
      `SELECT COUNT(*) as total FROM messages WHERE client_id = ? AND created_at >= ?`
    ).get(client.id, since);

    const rev = db.prepare(
      `SELECT COALESCE(COUNT(*) * ?, 0) as revenue FROM calls WHERE client_id = ? AND outcome = 'booked' AND created_at >= ?`
    ).get(client.avg_ticket || 0, client.id, since);

    const totalCalls = calls.total || 0;
    const missed = calls.missed || 0;
    const missedRate = totalCalls > 0 ? Math.round((missed / totalCalls) * 100) : 0;

    const report = {
      total_calls: totalCalls,
      booked: calls.booked || 0,
      missed,
      messages: msgs.total || 0,
      revenue: rev.revenue || 0,
      missed_rate: missedRate,
      ai_summary: null,
    };

    // Persist to weekly_reports table
    const weekStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const weekEnd = new Date().toISOString().split('T')[0];
    const reportId = `wr-${client.id}-${weekEnd}`;
    db.prepare(
      `INSERT OR REPLACE INTO weekly_reports (id, client_id, week_start, week_end, calls_answered, appointments_booked, messages_handled, estimated_revenue, missed_call_rate, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).run(reportId, client.id, weekStart, weekEnd, report.total_calls, report.booked, report.messages, report.revenue, report.missed_rate / 100);

    const formatted = telegram.formatWeeklyReport(report, client);
    telegram.sendMessage(client.telegram_chat_id, formatted.text).catch(err =>
      console.error(`Weekly report failed for client ${client.id}:`, err)
    );
  }
}

function initScheduler(db) {
  // Daily summary at 7 PM
  const now = new Date();
  const daily = new Date(now);
  daily.setHours(19, 0, 0, 0);
  if (daily <= now) daily.setDate(daily.getDate() + 1);
  const dailyDelay = daily.getTime() - now.getTime();

  setTimeout(() => {
    try {
      console.log('[Scheduler] Sending daily summaries');
      sendDailySummaries(db);
    } catch (err) {
      console.error('[Scheduler] Daily summary error:', err);
    }
    setInterval(() => {
      try {
        console.log('[Scheduler] Sending daily summaries');
        sendDailySummaries(db);
      } catch (err) {
        console.error('[Scheduler] Daily summary interval error:', err);
      }
    }, 24 * 60 * 60 * 1000);
  }, dailyDelay);

  console.log(`[Scheduler] Daily summary scheduled in ${Math.round(dailyDelay / 1000 / 60)} minutes (7 PM)`);

  // Weekly report Monday 8 AM
  const weekly = new Date(now);
  const dayOfWeek = weekly.getDay(); // 0=Sun, 1=Mon
  const daysUntilMonday = dayOfWeek === 0 ? 1 : dayOfWeek === 1 && now.getHours() < 8 ? 0 : 8 - dayOfWeek;
  weekly.setDate(weekly.getDate() + daysUntilMonday);
  weekly.setHours(8, 0, 0, 0);
  if (weekly <= now) weekly.setDate(weekly.getDate() + 7);
  const weeklyDelay = weekly.getTime() - now.getTime();

  setTimeout(() => {
    try {
      console.log('[Scheduler] Sending weekly reports');
      sendWeeklyReports(db);
    } catch (err) {
      console.error('[Scheduler] Weekly report error:', err);
    }
    setInterval(() => {
      try {
        console.log('[Scheduler] Sending weekly reports');
        sendWeeklyReports(db);
      } catch (err) {
        console.error('[Scheduler] Weekly report interval error:', err);
      }
    }, 7 * 24 * 60 * 60 * 1000);
  }, weeklyDelay);

  console.log(`[Scheduler] Weekly report scheduled in ${Math.round(weeklyDelay / 1000 / 60 / 60)} hours (Monday 8 AM)`);

  // Follow-up processor — every 5 minutes
  setInterval(() => {
    processFollowups(db).catch(err => console.error('[Scheduler] followup processor error:', err));
  }, 5 * 60 * 1000);
  console.log('[Scheduler] Follow-up processor running every 5 minutes');

  // Appointment reminder processor — every 2 minutes
  setInterval(() => {
    processAppointmentReminders(db).catch(err => console.error('[Scheduler] appointment reminder error:', err));
  }, 2 * 60 * 1000);
  console.log('[Scheduler] Appointment reminder processor running every 2 minutes');

  // Daily lead review — 9 AM
  const review = new Date(now);
  review.setHours(9, 0, 0, 0);
  if (review <= now) review.setDate(review.getDate() + 1);
  const reviewDelay = review.getTime() - now.getTime();

  setTimeout(() => {
    dailyLeadReview(db).catch(err => console.error('[Scheduler] daily review error:', err));
    setInterval(() => {
      dailyLeadReview(db).catch(err => console.error('[Scheduler] daily review error:', err));
    }, 24 * 60 * 60 * 1000);
  }, reviewDelay);
  console.log(`[Scheduler] Daily lead review scheduled in ${Math.round(reviewDelay / 1000 / 60)} minutes (9 AM)`);

  // Engine 2: Daily outreach at 10 AM
  const outreach = new Date(now);
  outreach.setHours(10, 0, 0, 0);
  if (outreach <= now) outreach.setDate(outreach.getDate() + 1);
  const outreachDelay = outreach.getTime() - now.getTime();

  setTimeout(() => {
    dailyOutreach(db).catch(err => console.error('[Scheduler] outreach error:', err));
    setInterval(() => {
      dailyOutreach(db).catch(err => console.error('[Scheduler] outreach error:', err));
    }, 24 * 60 * 60 * 1000);
  }, outreachDelay);
  console.log(`[Scheduler] Daily outreach scheduled in ${Math.round(outreachDelay / 1000 / 60)} minutes (10 AM)`);

  // Engine 2: Check replies every 30 minutes
  setInterval(() => {
    checkReplies(db).catch(err => console.error('[Scheduler] reply check error:', err));
  }, 30 * 60 * 1000);
  console.log('[Scheduler] Reply checker running every 30 minutes');
}

// === BRAIN-POWERED: Process due follow-ups ===
async function processFollowups(db) {
  try {
    const due = db.prepare(
      `SELECT f.*, l.phone, l.client_id as lead_client_id
       FROM followups f
       JOIN leads l ON f.lead_id = l.id
       WHERE f.status = 'scheduled' AND f.scheduled_at <= datetime('now')
       LIMIT 10`
    ).all();

    if (due.length === 0) return;
    console.log(`[Scheduler] Processing ${due.length} due follow-ups`);

    const { getLeadMemory } = require('./leadMemory');
    const { think } = require('./brain');
    const { executeActions } = require('./actionExecutor');

    for (const followup of due) {
      try {
        const memory = getLeadMemory(db, followup.phone, followup.lead_client_id || followup.client_id);
        if (!memory) {
          db.prepare("UPDATE followups SET status = 'failed' WHERE id = ?").run(followup.id);
          continue;
        }

        const decision = await think('followup_due', {
          followup_id: followup.id,
          touch_number: followup.touch_number,
          original_message: followup.content,
          scheduled_at: followup.scheduled_at,
        }, memory, db);

        await executeActions(db, decision.actions, memory);
        db.prepare("UPDATE followups SET status = 'sent', sent_at = datetime('now') WHERE id = ?").run(followup.id);
      } catch (err) {
        console.error(`[Scheduler] Follow-up ${followup.id} failed:`, err.message);
        db.prepare("UPDATE followups SET status = 'failed' WHERE id = ?").run(followup.id);
      }

      // Rate limit between brain calls
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch (err) {
    console.error('[Scheduler] processFollowups error:', err);
  }
}

// === BRAIN-POWERED: Daily stale lead review ===
async function dailyLeadReview(db) {
  try {
    const stale = db.prepare(`
      SELECT l.*, c.id as cid
      FROM leads l
      JOIN clients c ON l.client_id = c.id
      WHERE c.is_active = 1
      AND l.stage NOT IN ('booked', 'lost')
      AND l.updated_at < datetime('now', '-2 days')
      AND l.score >= 5
      ORDER BY l.score DESC
      LIMIT 10
    `).all();

    if (stale.length === 0) {
      console.log('[Brain] Daily review: no stale leads');
      return;
    }

    console.log(`[Brain] Daily review: ${stale.length} stale leads`);

    const { getLeadMemory } = require('./leadMemory');
    const { think } = require('./brain');
    const { executeActions } = require('./actionExecutor');

    for (const lead of stale) {
      try {
        const memory = getLeadMemory(db, lead.phone, lead.client_id);
        if (!memory) continue;

        const decision = await think('daily_review', {
          review_reason: 'Lead inactive 2+ days, not booked',
          lead_score: lead.score,
          lead_stage: lead.stage,
        }, memory, db);

        await executeActions(db, decision.actions, memory);
        await new Promise(r => setTimeout(r, 2000));
      } catch (err) {
        console.error(`[Brain] Daily review failed for ${lead.phone}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[Brain] dailyLeadReview error:', err);
  }
}

// === Appointment Reminders ===
function createAppointmentReminders(db, appointment, client) {
  try {
    if (!appointment || !appointment.id || !appointment.datetime) {
      console.warn('[Scheduler] createAppointmentReminders: missing appointment data');
      return;
    }

    const apptTime = new Date(appointment.datetime);
    if (isNaN(apptTime.getTime())) {
      console.warn('[Scheduler] Invalid appointment datetime:', appointment.datetime);
      return;
    }

    const leadId = appointment.lead_id;
    const clientId = appointment.client_id || client?.id;
    const name = appointment.name || 'there';
    const service = appointment.service || 'appointment';
    const timeStr = apptTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const businessName = client?.business_name || 'us';

    const reminders = [
      {
        touchNumber: 10,
        delayBefore: 24 * 60 * 60 * 1000, // 24h before
        content: `Hi ${name}! Just confirming your ${service} appointment tomorrow at ${timeStr}. Reply YES to confirm or call us to reschedule.`,
      },
      {
        touchNumber: 11,
        delayBefore: 2 * 60 * 60 * 1000, // 2h before
        content: `Reminder: Your ${service} appointment is in 2 hours at ${timeStr}. See you soon! — ${businessName}`,
      },
    ];

    const { randomUUID } = require('crypto');

    for (const r of reminders) {
      const scheduledAt = new Date(apptTime.getTime() - r.delayBefore);
      // Only schedule if in the future
      if (scheduledAt.getTime() <= Date.now()) continue;

      // Dedup
      const existing = db.prepare(
        "SELECT id FROM followups WHERE lead_id = ? AND touch_number = ? AND type = 'reminder' AND status = 'scheduled'"
      ).get(leadId, r.touchNumber);
      if (existing) continue;

      db.prepare(`
        INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, content_source, scheduled_at, status)
        VALUES (?, ?, ?, ?, 'reminder', ?, 'template', ?, 'scheduled')
      `).run(randomUUID(), leadId, clientId, r.touchNumber, r.content, scheduledAt.toISOString());
    }

    console.log(`[Scheduler] Appointment reminders created for ${appointment.phone || name}`);
  } catch (err) {
    console.error('[Scheduler] createAppointmentReminders error:', err.message);
  }
}

// === ENGINE 2: Daily Cold Email Outreach ===
async function dailyOutreach(db) {
  try {
    const { generateColdEmail } = require('./emailGenerator');
    const { sendColdEmail, DAILY_LIMIT } = require('./emailSender');

    // Get unsent prospects with email addresses
    const prospects = db.prepare(`
      SELECT * FROM prospects
      WHERE status = 'new' AND email IS NOT NULL AND email != ''
      ORDER BY rating DESC, review_count DESC
      LIMIT ?
    `).all(DAILY_LIMIT);

    if (prospects.length === 0) {
      console.log('[Outreach] No new prospects to email');
      return;
    }

    console.log(`[Outreach] Starting daily outreach: ${prospects.length} prospects`);
    let sent = 0, failed = 0;

    const { verifyEmail } = require('./emailVerifier');

    for (const prospect of prospects) {
      try {
        // Verify email before generating + sending
        const verification = await verifyEmail(prospect.email);
        if (!verification.valid) {
          console.log(`[Outreach] Skipping invalid email ${prospect.email}: ${verification.reason}`);
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
        await new Promise(r => setTimeout(r, 120000));
      } catch (err) {
        console.error(`[Outreach] Error for ${prospect.business_name}:`, err.message);
        failed++;
      }
    }

    // Notify owner via Telegram
    const clients = db.prepare('SELECT telegram_chat_id FROM clients WHERE telegram_chat_id IS NOT NULL LIMIT 1').all();
    for (const c of clients) {
      telegram.sendMessage(c.telegram_chat_id,
        `<b>Daily Outreach Complete</b>\n\nSent: ${sent}\nFailed: ${failed}\nRemaining prospects: ${db.prepare("SELECT COUNT(*) as c FROM prospects WHERE status = 'new' AND email IS NOT NULL").get().c}`
      ).catch(() => {});
    }

    console.log(`[Outreach] Done: ${sent} sent, ${failed} failed`);
  } catch (err) {
    console.error('[Outreach] dailyOutreach error:', err);
  }
}

// === ENGINE 2: Check IMAP for replies ===
async function checkReplies(db) {
  try {
    // Only run if IMAP is configured
    if (!process.env.IMAP_USER || !process.env.IMAP_PASS) {
      return;
    }

    const Imap = require('node-imap');
    const { classifyReply } = require('./replyClassifier');
    const { simpleParser } = require('mailparser');

    const imap = new Imap({
      user: process.env.IMAP_USER,
      password: process.env.IMAP_PASS,
      host: process.env.IMAP_HOST || 'imap.gmail.com',
      port: parseInt(process.env.IMAP_PORT || '993', 10),
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
    });

    await new Promise((resolve, reject) => {
      imap.once('ready', () => {
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
                      console.log(`[Replies] No matching email found for reply from: ${from}`);
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
                  console.log(`[Replies] ${from}: ${result.classification} -- ${result.summary}`);

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
                      ).catch(() => {});
                    }
                  }
                } catch (parseErr) {
                  console.error('[Replies] Error processing reply:', parseErr.message);
                }
              }

              imap.end();
              resolve();
            });
          });
        });
      });

      imap.once('error', (err) => { console.error('[IMAP] Error:', err.message); reject(err); });
      imap.connect();
    });
  } catch (err) {
    console.error('[Replies] checkReplies error:', err.message);
  }
}

/**
 * Process due appointment reminders and send them
 */
async function processAppointmentReminders(db) {
  try {
    const { processDueReminders } = require('./appointmentReminders');
    const { sendSMS } = require('./sms');

    await processDueReminders(db, async (phone, message, from) => {
      return sendSMS(phone, message, from, db);
    });
  } catch (err) {
    console.error('[Scheduler] processAppointmentReminders error:', err.message);
  }
}

module.exports = {
  initScheduler,
  sendDailySummaries,
  sendWeeklyReports,
  processFollowups,
  dailyLeadReview,
  createAppointmentReminders,
  processAppointmentReminders,
  dailyOutreach,
  checkReplies
};
