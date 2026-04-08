/**
 * Niche-specific AI prompt templates for ELYVN
 *
 * These templates make the AI receptionist sound like it actually works at
 * the specific type of business. This is the competitive moat — competitors
 * use generic prompts. We use industry-trained ones.
 *
 * Template data lives in ./templates/data.js (split for maintainability).
 */

const { NICHE_TEMPLATES, INDUSTRY_MAP } = require('./templates/data');

/**
 * Get the niche template for a given industry
 * @param {string} industry - Industry name (case-insensitive)
 * @returns {object|null} Template object or null if no match
 */
function getNicheTemplate(industry) {
  if (!industry) return null;
  const key = INDUSTRY_MAP[industry.toLowerCase().trim()];
  return key ? NICHE_TEMPLATES[key] : null;
}

/**
 * Generate a complete system prompt for a client
 * @param {object} client - Client record from DB
 * @returns {string} Complete system prompt
 */
function generateSystemPrompt(client) {
  const template = getNicheTemplate(client.industry);
  const base = template?.systemPrompt || `You are a professional, friendly receptionist for {{business_name}}.

KNOWLEDGE:
{{knowledge_base}}

Answer calls professionally, collect caller information (name, phone, reason for calling), and help schedule appointments.

BOOKING LINK: {{booking_link}}
BUSINESS HOURS: {{business_hours}}`;

  return base
    .replace(/\{\{business_name\}\}/g, client.business_name || client.name || 'our office')
    .replace(/\{\{knowledge_base\}\}/g, client.knowledge_base || 'No specific knowledge base configured.')
    .replace(/\{\{booking_link\}\}/g, client.calcom_booking_link || client.booking_link || '')
    .replace(/\{\{business_hours\}\}/g, client.business_hours || 'Monday-Friday 9am-5pm');
}

/**
 * Generate a follow-up SMS template for a client
 * @param {object} client - Client record from DB
 * @param {string} callerName
 * @param {string} message
 * @returns {string}
 */
function generateFollowUpSms(client, callerName, message) {
  const template = getNicheTemplate(client.industry);
  const smsTemplate = template?.followUpSms || "Hi {{name}}, thanks for contacting {{business_name}}. {{message}}";

  return smsTemplate
    .replace(/\{\{name\}\}/g, callerName || 'there')
    .replace(/\{\{business_name\}\}/g, client.business_name || client.name || 'us')
    .replace(/\{\{message\}\}/g, message || '');
}

/**
 * Generate a voicemail text-back for a client
 * @param {object} client - Client record from DB
 * @param {string} callerName
 * @returns {string}
 */
function generateVoicemailText(client, callerName) {
  const template = getNicheTemplate(client.industry);
  const vmTemplate = template?.voicemailText || "Hi {{name}}, we missed your call at {{business_name}}. How can we help? {{booking_link}}";

  return vmTemplate
    .replace(/\{\{name\}\}/g, callerName || 'there')
    .replace(/\{\{business_name\}\}/g, client.business_name || client.name || 'us')
    .replace(/\{\{booking_link\}\}/g, client.calcom_booking_link || client.booking_link || '');
}

module.exports = {
  NICHE_TEMPLATES,
  INDUSTRY_MAP,
  getNicheTemplate,
  generateSystemPrompt,
  generateFollowUpSms,
  generateVoicemailText,
};
