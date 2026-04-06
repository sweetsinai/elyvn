const { SCHEDULER_DAILY_INTERVAL_MS, SCHEDULER_WEEKLY_INTERVAL_MS, SCHEDULER_FOLLOWUP_INTERVAL_MS, SCHEDULER_APPOINTMENT_REMINDER_INTERVAL_MS, SCHEDULER_REPLY_CHECK_INTERVAL_MS } = require('../config/timing');
const { logger } = require('./logger');

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
  const now = new Date();
  const daily = new Date(now);
  daily.setHours(19, 0, 0, 0);
  if (daily <= now) daily.setDate(daily.getDate() + 1);
  const dailyDelay = daily.getTime() - now.getTime();

  timerHandles.push(setTimeout(() => {
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

  logger.info(`[Scheduler] Daily summary scheduled in ${Math.round(dailyDelay / 1000 / 60)} minutes (7 PM)`);

  // Weekly report Monday 8 AM
  const weekly = new Date(now);
  const dayOfWeek = weekly.getDay(); // 0=Sun, 1=Mon
  const daysUntilMonday = dayOfWeek === 0 ? 1 : dayOfWeek === 1 && now.getHours() < 8 ? 0 : 8 - dayOfWeek;
  weekly.setDate(weekly.getDate() + daysUntilMonday);
  weekly.setHours(8, 0, 0, 0);
  if (weekly <= now) weekly.setDate(weekly.getDate() + 7);
  const weeklyDelay = weekly.getTime() - now.getTime();

  timerHandles.push(setTimeout(() => {
    try {
      logger.info('[Scheduler] Sending weekly reports');
      sendWeeklyReports(db);
    } catch (err) {
      logger.error('[Scheduler] Weekly report error:', err);
    }
    timerHandles.push(setInterval(() => {
      try {
        logger.info('[Scheduler] Sending weekly reports');
        sendWeeklyReports(db);
      } catch (err) {
        logger.error('[Scheduler] Weekly report interval error:', err);
      }
    }, SCHEDULER_WEEKLY_INTERVAL_MS));
  }, weeklyDelay));

  logger.info(`[Scheduler] Weekly report scheduled in ${Math.round(weeklyDelay / 1000 / 60 / 60)} hours (Monday 8 AM)`);

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
  const review = new Date(now);
  review.setHours(9, 0, 0, 0);
  if (review <= now) review.setDate(review.getDate() + 1);
  const reviewDelay = review.getTime() - now.getTime();

  timerHandles.push(setTimeout(() => {
    dailyLeadReview(db).catch(err => logger.error('[Scheduler] daily review error:', err));
    timerHandles.push(setInterval(() => {
      dailyLeadReview(db).catch(err => logger.error('[Scheduler] daily review error:', err));
    }, SCHEDULER_DAILY_INTERVAL_MS));
  }, reviewDelay));
  logger.info(`[Scheduler] Daily lead review scheduled in ${Math.round(reviewDelay / 1000 / 60)} minutes (9 AM)`);

  // Engine 2: Daily outreach at 10 AM
  const outreach = new Date(now);
  outreach.setHours(10, 0, 0, 0);
  if (outreach <= now) outreach.setDate(outreach.getDate() + 1);
  const outreachDelay = outreach.getTime() - now.getTime();

  timerHandles.push(setTimeout(() => {
    dailyOutreach(db).catch(err => logger.error('[Scheduler] outreach error:', err));
    timerHandles.push(setInterval(() => {
      dailyOutreach(db).catch(err => logger.error('[Scheduler] outreach error:', err));
    }, SCHEDULER_DAILY_INTERVAL_MS));
  }, outreachDelay));
  logger.info(`[Scheduler] Daily outreach scheduled in ${Math.round(outreachDelay / 1000 / 60)} minutes (10 AM)`);

  // Engine 2: Check replies every 30 minutes
  timerHandles.push(setInterval(() => {
    checkReplies(db).catch(err => logger.error('[Scheduler] reply check error:', err));
  }, SCHEDULER_REPLY_CHECK_INTERVAL_MS));
  logger.info('[Scheduler] Reply checker running every 30 minutes');

  // Predictive lead scoring — rescore all leads daily at 6 AM
  const scoreTime = new Date(now);
  scoreTime.setHours(6, 0, 0, 0);
  if (scoreTime <= now) scoreTime.setDate(scoreTime.getDate() + 1);
  const scoreDelay = scoreTime.getTime() - now.getTime();

  timerHandles.push(setTimeout(() => {
    dailyLeadScoring(db).catch(err => logger.error('[Scheduler] lead scoring error:', err));
    timerHandles.push(setInterval(() => {
      dailyLeadScoring(db).catch(err => logger.error('[Scheduler] lead scoring error:', err));
    }, SCHEDULER_DAILY_INTERVAL_MS));
  }, scoreDelay));
  logger.info(`[Scheduler] Daily lead scoring scheduled in ${Math.round(scoreDelay / 1000 / 60)} minutes (6 AM)`);

  // Data retention cleanup — daily at 3 AM
  const retentionTime = new Date(now);
  retentionTime.setHours(3, 0, 0, 0);
  if (retentionTime <= now) retentionTime.setDate(retentionTime.getDate() + 1);
  const retentionDelay = retentionTime.getTime() - now.getTime();

  timerHandles.push(setTimeout(() => {
    try {
      const { runRetention } = require('./dataRetention');
      const result = runRetention(db);
      logger.info(`[Scheduler] Data retention completed: ${JSON.stringify(result)}`);
    } catch (err) { logger.error('[Scheduler] data retention error:', err); }
    timerHandles.push(setInterval(() => {
      try {
        const { runRetention } = require('./dataRetention');
        runRetention(db);
      } catch (err) { logger.error('[Scheduler] data retention error:', err); }
    }, SCHEDULER_DAILY_INTERVAL_MS));
  }, retentionDelay));
  logger.info(`[Scheduler] Data retention scheduled in ${Math.round(retentionDelay / 1000 / 60)} minutes (3 AM)`);
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
