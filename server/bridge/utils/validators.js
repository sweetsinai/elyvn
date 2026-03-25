/**
 * Input Validation Utilities
 * Validates phone, email, UUID, lead stages, brain actions, etc.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE_RE = /^\+?[1-9]\d{6,14}$/;
const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

const VALID_STAGES = ['new', 'contacted', 'warm', 'hot', 'booked', 'completed', 'lost', 'nurture'];
const VALID_ACTIONS = ['send_sms', 'schedule_followup', 'cancel_pending_followups', 'update_lead_stage', 'update_lead_score', 'book_appointment', 'notify_owner', 'log_insight', 'no_action'];

/**
 * Validate UUID format
 * @param {string} str - String to validate
 * @returns {boolean}
 */
function isValidUUID(str) {
  return UUID_RE.test(str);
}

/**
 * Validate phone number format (E.164 or simple formats)
 * @param {string} str - String to validate
 * @returns {boolean}
 */
function isValidPhone(str) {
  return typeof str === 'string' && PHONE_RE.test(str.replace(/[\s\-()]/g, ''));
}

/**
 * Validate email address format
 * @param {string} str - String to validate
 * @returns {boolean}
 */
function isValidEmail(str) {
  return typeof str === 'string' && EMAIL_RE.test(str);
}

/**
 * Validate lead stage (new|contacted|warm|hot|booked|completed|lost|nurture)
 * @param {string} str - Stage to validate
 * @returns {boolean}
 */
function isValidStage(str) {
  return VALID_STAGES.includes(str);
}

/**
 * Validate brain action type
 * @param {string} str - Action to validate
 * @returns {boolean}
 */
function isValidAction(str) {
  return VALID_ACTIONS.includes(str);
}

/**
 * Sanitize string input (remove control characters, limit length)
 * @param {string} str - String to sanitize
 * @param {number} maxLen - Maximum length (default 1000)
 * @returns {string}
 */
function sanitizeString(str, maxLen = 1000) {
  if (typeof str !== 'string') return '';
  return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').substring(0, maxLen);
}

module.exports = {
  isValidUUID,
  isValidPhone,
  isValidEmail,
  isValidStage,
  isValidAction,
  sanitizeString,
  VALID_STAGES,
  VALID_ACTIONS,
  UUID_RE,
  PHONE_RE,
  EMAIL_RE,
};
