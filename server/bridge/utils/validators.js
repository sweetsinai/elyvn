'use strict';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE_RE = /^\+?[1-9]\d{6,14}$/;
const EMAIL_RE = /^[a-zA-Z0-9._+-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
const URL_RE = /^https?:\/\/[^\s<>"{}|\\^`\[\]]+$/;

const VALID_STAGES = ['new', 'contacted', 'warm', 'hot', 'booked', 'completed', 'lost', 'nurture'];
const VALID_ACTIONS = ['send_sms', 'schedule_followup', 'cancel_pending_followups', 'update_lead_stage', 'update_lead_score', 'book_appointment', 'notify_owner', 'record_opt_out', 'log_insight', 'no_action'];

const LENGTH_LIMITS = {
  name: 200,
  email: 254,
  phone: 20,
  url: 2048,
  text: 5000,
  message: 2000,
  summary: 1000,
};

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

function sanitizeString(str, maxLen = LENGTH_LIMITS.text) {
  if (typeof str !== 'string') return '';
  // Remove control characters and basic HTML tags
  return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
            .replace(/<[^>]*>/g, '')
            .trim()
            .slice(0, maxLen);
}

function stripHtmlTags(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/<[^>]*>/g, '').trim();
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

function isValidStage(str) {
  return VALID_STAGES.includes(str);
}

function isValidAction(str) {
  return VALID_ACTIONS.includes(str);
}

/**
 * Result-based validators (returning { valid, error })
 */

function validateEmail(email) {
  if (!email) return { valid: false, error: 'Email is required' };
  if (typeof email !== 'string') return { valid: false, error: 'Email must be a string' };
  const trimmed = email.trim();
  if (trimmed.length === 0) return { valid: false, error: 'Email cannot be empty' };
  if (trimmed.length > LENGTH_LIMITS.email) return { valid: false, error: `Email exceeds maximum length of ${LENGTH_LIMITS.email} characters` };
  if (!EMAIL_RE.test(trimmed)) return { valid: false, error: 'Email format is invalid' };
  return { valid: true, error: null };
}

function validatePhone(phone) {
  if (!phone) return { valid: false, error: 'Phone is required' };
  if (typeof phone !== 'string') return { valid: false, error: 'Phone must be a string' };
  const trimmed = phone.trim();
  if (trimmed.length === 0) return { valid: false, error: 'Phone cannot be empty' };
  if (trimmed.length > LENGTH_LIMITS.phone) return { valid: false, error: `Phone exceeds maximum length of ${LENGTH_LIMITS.phone} characters` };
  const cleaned = trimmed.replace(/[\s\-().]/g, '');
  if (!PHONE_RE.test(cleaned)) return { valid: false, error: 'Phone format is invalid' };
  return { valid: true, error: null };
}

function validateUrl(url) {
  if (!url) return { valid: false, error: 'URL is required' };
  if (typeof url !== 'string') return { valid: false, error: 'URL must be a string' };
  const trimmed = url.trim();
  if (trimmed.length === 0) return { valid: false, error: 'URL cannot be empty' };
  if (trimmed.length > LENGTH_LIMITS.url) return { valid: false, error: `URL exceeds maximum length of ${LENGTH_LIMITS.url} characters` };
  if (!URL_RE.test(trimmed)) return { valid: false, error: 'URL format is invalid (must start with http:// or https://)' };
  return { valid: true, error: null };
}

function validateLength(str, fieldName, maxLength) {
  if (str === null || str === undefined) return { valid: true, error: null };
  if (typeof str !== 'string') return { valid: false, error: `${fieldName} must be a string` };
  if (str.length > maxLength) return { valid: false, error: `${fieldName} exceeds maximum length of ${maxLength} characters` };
  return { valid: true, error: null };
}

function validateStringField(str, fieldName, minLength = 1, maxLength = LENGTH_LIMITS.text) {
  if (!str) return { valid: false, error: `${fieldName} is required` };
  if (typeof str !== 'string') return { valid: false, error: `${fieldName} must be a string` };
  const trimmed = str.trim();
  if (trimmed.length < minLength) return { valid: false, error: `${fieldName} must be at least ${minLength} characters` };
  if (trimmed.length > maxLength) return { valid: false, error: `${fieldName} exceeds maximum length of ${maxLength} characters` };
  return { valid: true, error: null };
}

function validateParameters(params, schema) {
  const errors = {};
  for (const [fieldName, rules] of Object.entries(schema)) {
    const value = params[fieldName];
    if (rules.required && (value === null || value === undefined || value === '')) {
      errors[fieldName] = `${fieldName} is required`;
      continue;
    }
    if (!rules.required && (value === null || value === undefined || value === '')) continue;
    const actualType = Array.isArray(value) ? 'array' : typeof value;
    if (rules.type && actualType !== rules.type) {
      errors[fieldName] = `${fieldName} must be of type ${rules.type}`;
      continue;
    }
    if (rules.maxLength && typeof value === 'string' && value.length > rules.maxLength) {
      errors[fieldName] = `${fieldName} exceeds maximum length of ${rules.maxLength}`;
      continue;
    }
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

function validatePaginationParams(page, limit) {
  return {
    page: Math.max(1, Math.min(1000, parseInt(page) || 1)),
    limit: Math.max(1, Math.min(100, parseInt(limit) || 20)),
  };
}

const ALLOWED_SORT_COLUMNS = ['created_at', 'updated_at', 'score', 'name', 'phone', 'stage', 'duration', 'sentiment'];
function validateSortColumn(column) {
  return ALLOWED_SORT_COLUMNS.includes(column) ? column : 'created_at';
}

function validateSortDirection(dir) {
  const upper = (dir || 'DESC').toUpperCase();
  return upper === 'ASC' || upper === 'DESC' ? upper : 'DESC';
}

module.exports = {
  isValidUUID,
  isValidPhone,
  isValidEmail,
  isValidURL,
  sanitizeString,
  stripHtmlTags,
  escapeLikePattern,
  validateNumericRange,
  isValidStage,
  isValidAction,
  VALID_STAGES,
  VALID_ACTIONS,
  UUID_RE,
  PHONE_RE,
  EMAIL_RE,
  LENGTH_LIMITS,
  validateEmail,
  validatePhone,
  validateUrl,
  validateLength,
  validateStringField,
  validateParameters,
  validatePaginationParams,
  validateSortColumn,
  validateSortDirection,
};
