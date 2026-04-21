/**
 * Lead Scoring Module — Re-exports
 *
 * Backward-compatible barrel file. All existing imports from
 * '../utils/scoring' continue to work via '../utils/scoring'.
 */

const { predictLeadScore } = require('./model');
const { getConversionAnalytics, batchScoreLeads, getLeadScoringReport } = require('./analytics');

module.exports = {
  predictLeadScore,
  getConversionAnalytics,
  batchScoreLeads,
  getLeadScoringReport,
};
