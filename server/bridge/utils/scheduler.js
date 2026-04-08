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

function initScheduler(db) {
  if (schedulerInitialized) {
    logger.warn('[scheduler] initScheduler called again — ignoring duplicate initialization');
    return;
  }
  schedulerInitialized = true;
  // Daily summary at 7 PM
  const dailyDelay = getDelayUntilHour(19);

  timerHandles.push(setTimeout(() => {
    if (!schedulerInitialized) return;
    try {
      logger.info('[Scheduler] Sending daily summaries');
      sendDailySummaries(db);
    } catch (err) {
      logger.error('[Scheduler] Daily summary error:', err);
    }
    timerHandles.push(setInterval(() => {
      try {
        logger.info('[Scheduler] Sending daily summaries');
        sendDailySummaries(db);
      } catch (err) {
        logger.error('[Scheduler] Daily summary interval error:', err);
      }
    }, SCHEDULER_DAILY_INTERVAL_MS));
  }, dailyDelay));

  logger.info(`[Scheduler] Daily summary scheduled ${formatDelay(dailyDelay)} (7 PM)`);

  // Weekly report Monday 8 AM
  const weeklyDelay = getDelayUntilDayOfWeek(1, 8);

  timerHandles.push(setTimeout(() => {
    if (!schedulerInitialized) return;
    logger.info('[Scheduler] Sending weekly reports');
    sendWeeklyReports(db).catch(err => logger.error('[Scheduler] Weekly report error:', err));
    timerHandles.push(setInterval(() => {
      logger.info('[Scheduler] Sending weekly reports');
      sendWeeklyReports(db).catch(err => logger.error('[Scheduler] Weekly report interval error:', err));
    }, SCHEDULER_WEEKLY_INTERVAL_MS));
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

  timerHandles.push(setTimeout(() => {
    if (!schedulerInitialized) return;
    dailyLeadReview(db).catch(err => logger.error('[Scheduler] daily review error:', err));
    timerHandles.push(setInterval(() => {
      dailyLeadReview(db).catch(err => logger.error('[Scheduler] daily review error:', err));
    }, SCHEDULER_DAILY_INTERVAL_MS));
  }, reviewDelay));
  logger.info(`[Scheduler] Daily lead review scheduled ${formatDelay(reviewDelay)} (9 AM)`);

  // Engine 2: Daily outreach at 10 AM
  const outreachDelay = getDelayUntilHour(10);

  timerHandles.push(setTimeout(() => {
    if (!schedulerInitialized) return;
    dailyOutreach(db).catch(err => logger.error('[Scheduler] outreach error:', err));
    timerHandles.push(setInterval(() => {
      dailyOutreach(db).catch(err => logger.error('[Scheduler] outreach error:', err));
    }, SCHEDULER_DAILY_INTERVAL_MS));
  }, outreachDelay));
  logger.info(`[Scheduler] Daily outreach scheduled ${formatDelay(outreachDelay)} (10 AM)`);

  // Engine 2: Check replies every 30 minutes
  timerHandles.push(setInterval(() => {
    checkReplies(db).catch(err => logger.error('[Scheduler] reply check error:', err));
  }, SCHEDULER_REPLY_CHECK_INTERVAL_MS));
  logger.info('[Scheduler] Reply checker running every 30 minutes');

  // Predictive lead scoring — rescore all leads daily at 6 AM
  const scoreDelay = getDelayUntilHour(6);

  timerHandles.push(setTimeout(() => {
    if (!schedulerInitialized) return;
    dailyLeadScoring(db).catch(err => logger.error('[Scheduler] lead scoring error:', err));
    timerHandles.push(setInterval(() => {
      dailyLeadScoring(db).catch(err => logger.error('[Scheduler] lead scoring error:', err));
    }, SCHEDULER_DAILY_INTERVAL_MS));
  }, scoreDelay));
  logger.info(`[Scheduler] Daily lead scoring scheduled ${formatDelay(scoreDelay)} (6 AM)`);

  // Data retention cleanup — daily at 3 AM
  const retentionDelay = getDelayUntilHour(3);

  timerHandles.push(setTimeout(() => {
    if (!schedulerInitialized) return;
    const { runRetention } = require('./dataRetention');
    runRetention(db).then(result => {
      logger.info(`[Scheduler] Data retention completed: ${JSON.stringify(result)}`);
    }).catch(err => logger.error('[Scheduler] data retention error:', err));
    timerHandles.push(setInterval(() => {
      const { runRetention } = require('./dataRetention');
      runRetention(db).catch(err => logger.error('[Scheduler] data retention error:', err));
    }, SCHEDULER_DAILY_INTERVAL_MS));
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
