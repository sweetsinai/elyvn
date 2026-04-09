const { SCHEDULER_DAILY_INTERVAL_MS, SCHEDULER_WEEKLY_INTERVAL_MS, SCHEDULER_FOLLOWUP_INTERVAL_MS, SCHEDULER_APPOINTMENT_REMINDER_INTERVAL_MS, SCHEDULER_REPLY_CHECK_INTERVAL_MS } = require('../config/timing');
const { logger } = require('./logger');
const { getDelayUntilHour, getDelayUntilDayOfWeek, formatDelay } = require('./scheduling');

const { sendDailySummaries } = require('./schedulerJobs/dailySummary');
const { sendWeeklyReports } = require('./schedulerJobs/weeklyReport');
const { processFollowups } = require('./schedulerJobs/processFollowups');
const { createAppointmentReminders, processAppointmentReminders } = require('./schedulerJobs/appointmentReminders');
const { checkReplies } = require('./schedulerJobs/replyChecker');
const { dailyLeadReview } = require('./schedulerJobs/brainReview');
const { dailyOutreach } = require('./schedulerJobs/coldEmail');
const { dailyLeadScoring } = require('./schedulerJobs/leadScoring');

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
      { name: 'daily_outreach', hour: 10 },
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
      `INSERT INTO scheduler_state (job_name, last_run_at, last_status) VALUES (?, datetime('now'), 'ok')
       ON CONFLICT(job_name) DO UPDATE SET last_run_at = datetime('now'), last_status = 'ok'`,
      [jobName], 'run'
    );
    failureCounts[jobName] = 0;
  } catch (_) {}
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
        } catch (_) {}
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
        else if (jobName === 'daily_outreach') dailyOutreach(db).catch(() => {});
        else if (jobName === 'daily_summary') sendDailySummaries(db).catch(() => {});
        else if (jobName === 'weekly_report') sendWeeklyReports(db).catch(() => {});
      }, stagger);
      stagger += 30000; // 30s between missed jobs to avoid thundering herd
    }
  }).catch(() => {});

  // Daily summary at 7 PM
  const dailyDelay = getDelayUntilHour(19);

  const trackedDailySummary = withFailureTracking(db, 'daily_summary', () => sendDailySummaries(db));
  timerHandles.push(setTimeout(() => {
    if (!schedulerInitialized) return;
    trackedDailySummary();
    timerHandles.push(setInterval(trackedDailySummary, SCHEDULER_DAILY_INTERVAL_MS));
  }, dailyDelay));

  logger.info(`[Scheduler] Daily summary scheduled ${formatDelay(dailyDelay)} (7 PM)`);

  // Weekly report Monday 8 AM
  const weeklyDelay = getDelayUntilDayOfWeek(1, 8);

  const trackedWeeklyReport = withFailureTracking(db, 'weekly_report', () => sendWeeklyReports(db));
  timerHandles.push(setTimeout(() => {
    if (!schedulerInitialized) return;
    trackedWeeklyReport();
    timerHandles.push(setInterval(trackedWeeklyReport, SCHEDULER_WEEKLY_INTERVAL_MS));
  }, weeklyDelay));

  logger.info(`[Scheduler] Weekly report scheduled ${formatDelay(weeklyDelay)} (Monday 8 AM)`);

  // Follow-up processor — every 5 minutes
  timerHandles.push(setInterval(() => {
    processFollowups(db).catch(err => logger.error('[Scheduler] followup processor error:', err));
  }, SCHEDULER_FOLLOWUP_INTERVAL_MS));
  logger.info('[Scheduler] Follow-up processor running every 5 minutes');

  // Appointment reminder processor — every 2 minutes
  timerHandles.push(setInterval(() => {
    processAppointmentReminders(db).catch(err => logger.error('[Scheduler] appointment reminder error:', err));
  }, SCHEDULER_APPOINTMENT_REMINDER_INTERVAL_MS));
  logger.info('[Scheduler] Appointment reminder processor running every 2 minutes');

  // Daily lead review — 9 AM
  const reviewDelay = getDelayUntilHour(9);

  const trackedLeadReview = withFailureTracking(db, 'daily_lead_review', () => dailyLeadReview(db));
  timerHandles.push(setTimeout(() => {
    if (!schedulerInitialized) return;
    trackedLeadReview();
    timerHandles.push(setInterval(trackedLeadReview, SCHEDULER_DAILY_INTERVAL_MS));
  }, reviewDelay));
  logger.info(`[Scheduler] Daily lead review scheduled ${formatDelay(reviewDelay)} (9 AM)`);

  // Engine 2: Daily outreach at 10 AM
  const outreachDelay = getDelayUntilHour(10);

  const trackedOutreach = withFailureTracking(db, 'daily_outreach', () => dailyOutreach(db));
  timerHandles.push(setTimeout(() => {
    if (!schedulerInitialized) return;
    trackedOutreach();
    timerHandles.push(setInterval(trackedOutreach, SCHEDULER_DAILY_INTERVAL_MS));
  }, outreachDelay));
  logger.info(`[Scheduler] Daily outreach scheduled ${formatDelay(outreachDelay)} (10 AM)`);

  // Engine 2: Check replies every 30 minutes
  timerHandles.push(setInterval(() => {
    checkReplies(db).catch(err => logger.error('[Scheduler] reply check error:', err));
  }, SCHEDULER_REPLY_CHECK_INTERVAL_MS));
  logger.info('[Scheduler] Reply checker running every 30 minutes');

  // Predictive lead scoring — rescore all leads daily at 6 AM
  const scoreDelay = getDelayUntilHour(6);

  const trackedScoring = withFailureTracking(db, 'daily_lead_scoring', () => dailyLeadScoring(db));
  timerHandles.push(setTimeout(() => {
    if (!schedulerInitialized) return;
    trackedScoring();
    timerHandles.push(setInterval(trackedScoring, SCHEDULER_DAILY_INTERVAL_MS));
  }, scoreDelay));
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
    timerHandles.push(setInterval(trackedRetention, SCHEDULER_DAILY_INTERVAL_MS));
  }, retentionDelay));
  logger.info(`[Scheduler] Data retention scheduled ${formatDelay(retentionDelay)} (3 AM)`);
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
  processFollowups,
  dailyLeadReview,
  createAppointmentReminders,
  processAppointmentReminders,
  dailyOutreach,
  checkReplies,
  dailyLeadScoring,
};
