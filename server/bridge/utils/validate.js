'use strict';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE_RE = /^\+?[1-9]\d{6,14}$/;
const EMAIL_RE = /^[a-zA-Z0-9._+-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
const URL_RE = /^https?:\/\/[^\s<>"{}|\\^`\[\]]+$/;

function isValidUUID(str) {
  return typeof str === 'string' && UUID_RE.test(str);
}

function isValidPhone(str) {
  if (typeof str !== 'string') return false;
  const cleaned = str.replace(/[\s\-().]/g, '');
  return PHONE_RE.test(cleaned);
}

function isValidEmail(str) {
  return typeof str === 'string' && str.length <= 254 && EMAIL_RE.test(str);
}

function isValidURL(str) {
  return typeof str === 'string' && str.length <= 2048 && URL_RE.test(str);
}

function sanitizeString(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim().slice(0, maxLen);
}

function escapeLikePattern(str) {
  return str.replace(/[%_\\]/g, '\\$&');
}

function validateNumericRange(val, min, max, defaultVal) {
  if (val === null || val === undefined || typeof val === 'object') return defaultVal;
  const num = Number(val);
  if (isNaN(num) || num < min || num > max) return defaultVal;
  return num;
}

// === Functions from validators.js (merged for single source of truth) ===
const VALID_STAGES = ['new', 'contacted', 'warm', 'hot', 'booked', 'completed', 'lost', 'nurture'];
const VALID_ACTIONS = ['send_sms', 'schedule_followup', 'cancel_pending_followups', 'update_lead_stage', 'update_lead_score', 'book_appointment', 'notify_owner', 'log_insight', 'no_action'];

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

module.exports = { isValidUUID, isValidPhone, isValidEmail, isValidURL, sanitizeString, escapeLikePattern, validateNumericRange, isValidStage, isValidAction, VALID_STAGES, VALID_ACTIONS, UUID_RE, PHONE_RE, EMAIL_RE };
