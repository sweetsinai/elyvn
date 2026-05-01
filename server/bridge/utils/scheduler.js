const { SCHEDULER_DAILY_INTERVAL_MS, SCHEDULER_WEEKLY_INTERVAL_MS, SCHEDULER_APPOINTMENT_REMINDER_INTERVAL_MS, SCHEDULER_FOLLOWUP_INTERVAL_MS } = require('../config/timing');
const { logger } = require('./logger');
const { getDelayUntilHour, getDelayUntilDayOfWeek, formatDelay } = require('./scheduling');

const { sendDailySummaries } = require('./schedulerJobs/dailySummary');
const { sendWeeklyReports } = require('./schedulerJobs/weeklyReport');
const { createAppointmentReminders, processAppointmentReminders } = require('./schedulerJobs/appointmentReminders');
const { dailyLeadReview } = require('./schedulerJobs/brainReview');
const { dailyLeadScoring } = require('./schedulerJobs/leadScoring');
const { processFollowups } = require('./schedulerJobs/followups');

const timerHandles = [];
let schedulerInitialized = false;

// Track consecutive failures per job type for escalation
const failureCounts = {};
const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * Check if a daily job was missed (e.g., server restarted after scheduled time).
 * If last_run is >25h ago, run it immediately with stagger offset.
 */
async function checkMissedJobs(db) {
  try {
    // Ensure scheduler_state table exists
    await db.query(`CREATE TABLE IF NOT EXISTS scheduler_state (
      job_name TEXT PRIMARY KEY,
      last_run_at TEXT NOT NULL,
      last_status TEXT DEFAULT 'ok'
    )`, [], 'run');

    const dailyJobs = [
      { name: 'daily_summary', hour: 19 },
      { name: 'weekly_report', hour: 8 },
      { name: 'daily_lead_review', hour: 9 },
      { name: 'daily_lead_scoring', hour: 6 },
      { name: 'data_retention', hour: 3 },
    ];

    const missedJobs = [];
    for (const job of dailyJobs) {
      const state = await db.query('SELECT last_run_at FROM scheduler_state WHERE job_name = ?', [job.name], 'get');
      if (state) {
        const hoursSince = (Date.now() - new Date(state.last_run_at).getTime()) / (1000 * 60 * 60);
        if (hoursSince > 25) {
          missedJobs.push(job.name);
        }
      }
    }

    if (missedJobs.length > 0) {
      logger.warn(`[scheduler] Missed jobs detected on restart: ${missedJobs.join(', ')}`);
    }
    return missedJobs;
  } catch (err) {
    logger.warn('[scheduler] checkMissedJobs error:', err.message);
    return [];
  }
}

/**
 * Record that a job ran successfully.
 */
async function recordJobRun(db, jobName) {
  try {
    await db.query(
      `INSERT INTO scheduler_state (job_name, last_run_at, last_status) VALUES (?, ?, 'ok')
       ON CONFLICT(job_name) DO UPDATE SET last_run_at = excluded.last_run_at, last_status = 'ok'`,
      [jobName, new Date().toISOString()], 'run'
    );
    failureCounts[jobName] = 0;
  } catch (err) {
    logger.debug('Silent catch remediation:', err.message);
  }
}

/**
 * Wrap a job function with failure tracking and escalation.
 */
function withFailureTracking(db, jobName, fn) {
  return async () => {
    try {
      await fn();
      await recordJobRun(db, jobName);
    } catch (err) {
      failureCounts[jobName] = (failureCounts[jobName] || 0) + 1;
      logger.error(`[scheduler] ${jobName} failed (${failureCounts[jobName]}/${MAX_CONSECUTIVE_FAILURES}):`, err.message);

      if (failureCounts[jobName] >= MAX_CONSECUTIVE_FAILURES) {
        try {
          const { alertCriticalError } = require('../config/startup');
          if (alertCriticalError) alertCriticalError(new Error(`${jobName} failed ${MAX_CONSECUTIVE_FAILURES}x consecutively`), 'scheduler');
        } catch (err) {
    logger.debug('Silent catch remediation:', err.message);
  }
      }
    }
  };
}

function initScheduler(db) {
  if (schedulerInitialized) {
    logger.warn('[scheduler] initScheduler called again — ignoring duplicate initialization');
    return;
  }
  schedulerInitialized = true;

  // Check for missed jobs on restart and run them with stagger
  checkMissedJobs(db).then(missed => {
    let stagger = 0;
    for (const jobName of missed) {
      setTimeout(() => {
        logger.info(`[scheduler] Running missed job: ${jobName}`);
        if (jobName === 'daily_lead_scoring') dailyLeadScoring(db).catch(() => {});
        else if (jobName === 'daily_lead_review') dailyLeadReview(db).catch(() => {});
        else if (jobName === 'daily_summary') sendDailySummaries(db).catch(() => {});
        else if (jobName === 'weekly_report') sendWeeklyReports(db).catch(() => {});
      }, stagger).unref();
      stagger += 30000; // 30s between missed jobs to avoid thundering herd
    }
  }).catch(() => {});

  // Daily summary at 7 PM
  const dailyDelay = getDelayUntilHour(19);

  const trackedDailySummary = withFailureTracking(db, 'daily_summary', () => sendDailySummaries(db));
  timerHandles.push(setTimeout(() => {
    if (!schedulerInitialized) return;
    trackedDailySummary();
    timerHandles.push(setInterval(trackedDailySummary, SCHEDULER_DAILY_INTERVAL_MS).unref());
  }, dailyDelay).unref());

  logger.info(`[Scheduler] Daily summary scheduled ${formatDelay(dailyDelay)} (7 PM)`);

  // Weekly report Monday 8 AM
  const weeklyDelay = getDelayUntilDayOfWeek(1, 8);

  const trackedWeeklyReport = withFailureTracking(db, 'weekly_report', () => sendWeeklyReports(db));
  timerHandles.push(setTimeout(() => {
    if (!schedulerInitialized) return;
    trackedWeeklyReport();
    timerHandles.push(setInterval(trackedWeeklyReport, SCHEDULER_WEEKLY_INTERVAL_MS).unref());
  }, weeklyDelay).unref());

  logger.info(`[Scheduler] Weekly report scheduled ${formatDelay(weeklyDelay)} (Monday 8 AM)`);

  // Appointment reminder processor — every 2 minutes
  timerHandles.push(setInterval(() => {
    processAppointmentReminders(db).catch(err => logger.error('[Scheduler] appointment reminder error:', err));
  }, SCHEDULER_APPOINTMENT_REMINDER_INTERVAL_MS).unref());
  logger.info('[Scheduler] Appointment reminder processor running every 2 minutes');

  // Follow-up processor — every 5 minutes
  timerHandles.push(setInterval(() => {
    processFollowups(db).catch(err => logger.error('[Scheduler] followup processor error:', err));
  }, SCHEDULER_FOLLOWUP_INTERVAL_MS).unref());
  logger.info(`[Scheduler] Follow-up processor running every ${Math.round(SCHEDULER_FOLLOWUP_INTERVAL_MS / 60000)} minutes`);

  // Daily lead review — 9 AM
  const reviewDelay = getDelayUntilHour(9);

  const trackedLeadReview = withFailureTracking(db, 'daily_lead_review', () => dailyLeadReview(db));
  timerHandles.push(setTimeout(() => {
    if (!schedulerInitialized) return;
    trackedLeadReview();
    timerHandles.push(setInterval(trackedLeadReview, SCHEDULER_DAILY_INTERVAL_MS).unref());
  }, reviewDelay).unref());
  logger.info(`[Scheduler] Daily lead review scheduled ${formatDelay(reviewDelay)} (9 AM)`);

  // Predictive lead scoring — rescore all leads daily at 6 AM
  const scoreDelay = getDelayUntilHour(6);

  const trackedScoring = withFailureTracking(db, 'daily_lead_scoring', () => dailyLeadScoring(db));
  timerHandles.push(setTimeout(() => {
    if (!schedulerInitialized) return;
    trackedScoring();
    timerHandles.push(setInterval(trackedScoring, SCHEDULER_DAILY_INTERVAL_MS).unref());
  }, scoreDelay).unref());
  logger.info(`[Scheduler] Daily lead scoring scheduled ${formatDelay(scoreDelay)} (6 AM)`);

  // Data retention cleanup — daily at 3 AM
  const retentionDelay = getDelayUntilHour(3);

  const trackedRetention = withFailureTracking(db, 'data_retention', () => {
    const { runRetention } = require('./dataRetention');
    return runRetention(db);
  });
  timerHandles.push(setTimeout(() => {
    if (!schedulerInitialized) return;
    trackedRetention();
    timerHandles.push(setInterval(trackedRetention, SCHEDULER_DAILY_INTERVAL_MS).unref());
  }, retentionDelay).unref());
  logger.info(`[Scheduler] Data retention scheduled ${formatDelay(retentionDelay)} (3 AM)`);

  // Refresh token cleanup — daily at 4 AM
  const tokenCleanupDelay = getDelayUntilHour(4);

  const trackedTokenCleanup = withFailureTracking(db, 'refresh_token_cleanup', async () => {
    try {
      const result = await db.query(`
        DELETE FROM refresh_tokens 
        WHERE expires_at < datetime('now') 
           OR (revoked = 1 AND created_at < datetime('now', '-7 days'))
      `, [], 'run');
      logger.info(`[scheduler] Cleaned up ${result.changes} expired refresh tokens`);
    } catch (err) {
      logger.error('[scheduler] Refresh token cleanup failed:', err);
      throw err;
    }
  });
  timerHandles.push(setTimeout(() => {
    if (!schedulerInitialized) return;
    trackedTokenCleanup();
    timerHandles.push(setInterval(trackedTokenCleanup, SCHEDULER_DAILY_INTERVAL_MS).unref());
  }, tokenCleanupDelay).unref());
  logger.info(`[Scheduler] Refresh token cleanup scheduled ${formatDelay(tokenCleanupDelay)} (4 AM)`);
}

function stopScheduler() {
  timerHandles.forEach(t => { clearInterval(t); clearTimeout(t); });
  timerHandles.length = 0;
  schedulerInitialized = false;
  logger.info('[scheduler] All timers stopped');
}

module.exports = {
  initScheduler,
  stopScheduler,
  sendDailySummaries,
  sendWeeklyReports,
  dailyLeadReview,
  createAppointmentReminders,
  processAppointmentReminders,
  dailyLeadScoring,
  processFollowups,
};
