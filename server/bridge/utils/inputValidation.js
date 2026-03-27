'use strict';

/**
 * Input validation helper utilities for hardening route handlers
 * Provides length limits, format validation, and sanitization across all routes
 */

// Length limits (in characters)
const LENGTH_LIMITS = {
  name: 200,
  email: 254,
  phone: 20,
  url: 2048,
  text: 5000,
  message: 2000,
  summary: 1000,
};

// Email regex — comprehensive but not perfect (per RFC 5322)
const EMAIL_RE = /^[a-zA-Z0-9._+-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

// Phone regex — allows +, digits, spaces, dashes, parentheses
// Must have at least 7 digits total
const PHONE_RE = /^\+?[1-9]\d{6,14}$/;

// URL regex — basic HTTP/HTTPS validation
const URL_RE = /^https?:\/\/[^\s<>"{}|\\^`\[\]]+$/;

/**
 * Validate email format and length
 * @param {string} email - Email to validate
 * @returns {object} { valid: boolean, error: string|null }
 */
function validateEmail(email) {
  if (!email) {
    return { valid: false, error: 'Email is required' };
  }

  if (typeof email !== 'string') {
    return { valid: false, error: 'Email must be a string' };
  }

  const trimmed = email.trim();

  if (trimmed.length === 0) {
    return { valid: false, error: 'Email cannot be empty' };
  }

  if (trimmed.length > LENGTH_LIMITS.email) {
    return { valid: false, error: `Email exceeds maximum length of ${LENGTH_LIMITS.email} characters` };
  }

  if (!EMAIL_RE.test(trimmed)) {
    return { valid: false, error: 'Email format is invalid' };
  }

  return { valid: true, error: null };
}

/**
 * Validate phone format and length
 * @param {string} phone - Phone to validate
 * @returns {object} { valid: boolean, error: string|null }
 */
function validatePhone(phone) {
  if (!phone) {
    return { valid: false, error: 'Phone is required' };
  }

  if (typeof phone !== 'string') {
    return { valid: false, error: 'Phone must be a string' };
  }

  const trimmed = phone.trim();

  if (trimmed.length === 0) {
    return { valid: false, error: 'Phone cannot be empty' };
  }

  if (trimmed.length > LENGTH_LIMITS.phone) {
    return { valid: false, error: `Phone exceeds maximum length of ${LENGTH_LIMITS.phone} characters` };
  }

  // Remove formatting characters for validation
  const cleaned = trimmed.replace(/[\s\-().]/g, '');

  if (!PHONE_RE.test(cleaned)) {
    return { valid: false, error: 'Phone format is invalid' };
  }

  return { valid: true, error: null };
}

/**
 * Validate URL format and length
 * @param {string} url - URL to validate
 * @returns {object} { valid: boolean, error: string|null }
 */
function validateUrl(url) {
  if (!url) {
    return { valid: false, error: 'URL is required' };
  }

  if (typeof url !== 'string') {
    return { valid: false, error: 'URL must be a string' };
  }

  const trimmed = url.trim();

  if (trimmed.length === 0) {
    return { valid: false, error: 'URL cannot be empty' };
  }

  if (trimmed.length > LENGTH_LIMITS.url) {
    return { valid: false, error: `URL exceeds maximum length of ${LENGTH_LIMITS.url} characters` };
  }

  if (!URL_RE.test(trimmed)) {
    return { valid: false, error: 'URL format is invalid (must start with http:// or https://)' };
  }

  return { valid: true, error: null };
}

/**
 * Validate string length
 * @param {string} str - String to validate
 * @param {string} fieldName - Field name for error message
 * @param {number} maxLength - Maximum allowed length
 * @returns {object} { valid: boolean, error: string|null }
 */
function validateLength(str, fieldName, maxLength) {
  if (str === null || str === undefined) {
    return { valid: true, error: null }; // Optional field
  }

  if (typeof str !== 'string') {
    return { valid: false, error: `${fieldName} must be a string` };
  }

  if (str.length > maxLength) {
    return { valid: false, error: `${fieldName} exceeds maximum length of ${maxLength} characters` };
  }

  return { valid: true, error: null };
}

/**
 * Sanitize string by removing control characters and HTML tags
 * @param {string} str - String to sanitize
 * @param {number} maxLen - Maximum length (default 5000)
 * @returns {string} Sanitized string
 */
function sanitizeString(str, maxLen = LENGTH_LIMITS.text) {
  if (typeof str !== 'string') {
    return '';
  }

  // Remove control characters
  let result = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

  // Strip HTML/script tags (basic — not comprehensive)
  result = result.replace(/<[^>]*>/g, '');

  // Trim whitespace and truncate
  return result.trim().slice(0, maxLen);
}

/**
 * Strip HTML/script tags from string
 * @param {string} str - String to strip
 * @returns {string} String with tags removed
 */
function stripHtmlTags(str) {
  if (typeof str !== 'string') {
    return '';
  }

  return str.replace(/<[^>]*>/g, '').trim();
}

/**
 * Validate a string is not empty and has reasonable length
 * @param {string} str - String to validate
 * @param {string} fieldName - Field name for error message
 * @param {number} minLength - Minimum length
 * @param {number} maxLength - Maximum length
 * @returns {object} { valid: boolean, error: string|null }
 */
function validateStringField(str, fieldName, minLength = 1, maxLength = LENGTH_LIMITS.text) {
  if (!str) {
    return { valid: false, error: `${fieldName} is required` };
  }

  if (typeof str !== 'string') {
    return { valid: false, error: `${fieldName} must be a string` };
  }

  const trimmed = str.trim();

  if (trimmed.length < minLength) {
    return { valid: false, error: `${fieldName} must be at least ${minLength} characters` };
  }

  if (trimmed.length > maxLength) {
    return { valid: false, error: `${fieldName} exceeds maximum length of ${maxLength} characters` };
  }

  return { valid: true, error: null };
}

/**
 * Validate query/body parameters exist and have expected types
 * Returns object with field validation results
 * @param {object} params - Parameters to validate
 * @param {object} schema - Validation schema { fieldName: { type: 'string'|'number'|'boolean', required: boolean, maxLength?: number } }
 * @returns {object} { valid: boolean, errors: { fieldName: string } }
 */
function validateParameters(params, schema) {
  const errors = {};

  for (const [fieldName, rules] of Object.entries(schema)) {
    const value = params[fieldName];

    // Check required
    if (rules.required && (value === null || value === undefined || value === '')) {
      errors[fieldName] = `${fieldName} is required`;
      continue;
    }

    // Skip optional fields that are empty
    if (!rules.required && (value === null || value === undefined || value === '')) {
      continue;
    }

    // Check type
    const actualType = Array.isArray(value) ? 'array' : typeof value;
    if (rules.type && actualType !== rules.type) {
      errors[fieldName] = `${fieldName} must be of type ${rules.type}`;
      continue;
    }

    // Check length (for strings)
    if (rules.maxLength && typeof value === 'string' && value.length > rules.maxLength) {
      errors[fieldName] = `${fieldName} exceeds maximum length of ${rules.maxLength}`;
      continue;
    }
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

module.exports = {
  LENGTH_LIMITS,
  validateEmail,
  validatePhone,
  validateUrl,
  validateLength,
  sanitizeString,
  stripHtmlTags,
  validateStringField,
  validateParameters,
};
