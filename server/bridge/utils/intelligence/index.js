/**
 * Conversation Intelligence Module — Re-exports
 *
 * Backward-compatible barrel file. All existing imports from
 * '../utils/conversationIntelligence' continue to work via
 * '../utils/intelligence' or '../utils/intelligence/index'.
 */

const { getConversationIntelligence, getPeakHours, extractCommonTopics } = require('./callAnalysis');
const { analyzeResponseTimeImpact, getWeekOverWeekComparison, getCallDurationTrend } = require('./sentimentTrend');
const { generateCoachingTips } = require('./coachingTips');

module.exports = {
  getConversationIntelligence,
  analyzeResponseTimeImpact,
  getPeakHours,
  getCallDurationTrend,
  extractCommonTopics,
  generateCoachingTips,
  getWeekOverWeekComparison,
};
