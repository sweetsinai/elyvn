'use strict';

const { NICHE_TEMPLATES, INDUSTRY_MAP } = require('./templates/data');

/**
 * generateFollowUpSms
 * @param {Object} client
 * @param {string} name
 * @param {string} message
 * @returns {string}
 */
function generateFollowUpSms(client, name, message) {
  const nicheKey = INDUSTRY_MAP[(client.niche || '').toLowerCase()] || 'general';
  const niche = NICHE_TEMPLATES[nicheKey] || { 
    followUpSms: "Hi {{name}}! This is {{business_name}}. Thanks for calling. {{message}}" 
  };
  
  let text = niche.followUpSms || "Hi {{name}}! This is {{business_name}}. Thanks for calling. {{message}}";
  
  text = text.replace(/{{name}}/g, name || 'there');
  text = text.replace(/{{business_name}}/g, client.business_name || client.name || 'our team');
  text = text.replace(/{{message}}/g, message || '');
  text = text.replace(/{{booking_link}}/g, client.calcom_booking_link || '');
  
  // Niche specific fields
  text = text.replace(/{{petName}}/g, 'your pet');
  text = text.replace(/{{vehicle}}/g, 'your vehicle');
  
  return text.trim();
}

/**
 * generateVoicemailText
 * @param {Object} client
 * @param {string} phone
 * @returns {string}
 */
function generateVoicemailText(client, phone) {
  const nicheKey = INDUSTRY_MAP[(client.niche || '').toLowerCase()] || 'general';
  const niche = NICHE_TEMPLATES[nicheKey] || { 
    voicemailText: "Hi, we missed your call at {{business_name}}. We'd love to help you! You can book an appointment here: {{booking_link}} or just text us back." 
  };
  
  let text = niche.voicemailText || "Hi, we missed your call at {{business_name}}. We'd love to help you! You can book an appointment here: {{booking_link}} or just text us back.";
  
  text = text.replace(/{{name}}/g, 'there');
  text = text.replace(/{{business_name}}/g, client.business_name || client.name || 'our team');
  text = text.replace(/{{booking_link}}/g, client.calcom_booking_link || '');
  
  return text.trim();
}

/**
 * getNichePrompt
 * @param {string} nicheKey 
 * @returns {string|null}
 */
function getNichePrompt(nicheKey) {
  const key = INDUSTRY_MAP[(nicheKey || '').toLowerCase()] || 'general';
  return NICHE_TEMPLATES[key]?.systemPrompt || null;
}

/**
 * getNicheGreeting
 * @param {string} nicheKey 
 * @returns {string|null}
 */
function getNicheGreeting(nicheKey) {
  const key = INDUSTRY_MAP[(nicheKey || '').toLowerCase()] || 'general';
  return NICHE_TEMPLATES[key]?.greeting || null;
}

module.exports = {
  generateFollowUpSms,
  generateVoicemailText,
  getNichePrompt,
  getNicheGreeting
};
