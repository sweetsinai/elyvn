/**
 * Twilio SIP Trunk Provisioning
 *
 * Provides utilities to:
 *   1. Search for available phone numbers
 *   2. Purchase a Twilio number (voice + SMS capable)
 *   3. Create a SIP trunk and point it at Retell's SIP endpoint
 *   4. Associate a phone number with the trunk
 *   5. Configure the number's SMS webhook
 *
 * Uses raw HTTPS (no Twilio SDK) — consistent with sms.js pattern.
 */

const https = require('https');
const { logger } = require('./logger');

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

const { PROVISIONING_TIMEOUT_MS } = require('../config/timing');

function getAuth() {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required');
  }
  return Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
}

function httpsRequest(options, data = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: body ? JSON.parse(body) : {} });
        } catch (err) {
          resolve({ status: res.statusCode, body, parseError: err });
        }
      });
    });
    
    // Add timeout to avoid hanging on network issues
    req.setTimeout(PROVISIONING_TIMEOUT_MS || 30000, () => {
      req.destroy();
      reject(new Error(`Twilio API request timed out (${(PROVISIONING_TIMEOUT_MS || 30000) / 1000}s)`));
    });

    req.on('error', reject);
    if (data) req.write(typeof data === 'string' ? data : JSON.stringify(data));
    req.end();
  });
}

/**
 * Search for available phone numbers in a given country.
 * @param {string} countryCode - ISO country code (e.g. 'US', 'GB')
 * @param {object} opts - { areaCode, contains, smsEnabled, voiceEnabled, limit }
 * @returns {Promise<Array<{phoneNumber, friendlyName, capabilities}>>}
 */
async function searchAvailableNumbers(countryCode = 'US', opts = {}) {
  const params = new URLSearchParams();
  if (opts.areaCode) params.set('AreaCode', opts.areaCode);
  if (opts.contains) params.set('Contains', opts.contains);
  params.set('SmsEnabled', opts.smsEnabled !== false ? 'true' : 'false');
  params.set('VoiceEnabled', opts.voiceEnabled !== false ? 'true' : 'false');
  params.set('PageSize', String(opts.limit || 5));

  const qs = params.toString();
  const response = await httpsRequest({
    hostname: 'api.twilio.com',
    port: 443,
    path: `/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/AvailablePhoneNumbers/${countryCode}/Local.json?${qs}`,
    method: 'GET',
    headers: { 'Authorization': `Basic ${getAuth()}` },
  });

  if (response.status !== 200) {
    throw new Error(`Twilio search failed (${response.status}): ${JSON.stringify(response.body)}`);
  }

  return (response.body.available_phone_numbers || []).map(n => ({
    phoneNumber: n.phone_number,
    friendlyName: n.friendly_name,
    capabilities: n.capabilities,
  }));
}

/**
 * Purchase a phone number.
 * @param {string} phoneNumber - E.164 formatted number
 * @param {string} [smsWebhookUrl] - URL for inbound SMS webhook
 * @returns {Promise<{sid, phoneNumber, friendlyName}>}
 */
async function purchaseNumber(phoneNumber, smsWebhookUrl) {
  const formData = new URLSearchParams({
    PhoneNumber: phoneNumber,
  });
  if (smsWebhookUrl) {
    formData.set('SmsUrl', smsWebhookUrl);
    formData.set('SmsMethod', 'POST');
  }

  const data = formData.toString();
  const response = await httpsRequest({
    hostname: 'api.twilio.com',
    port: 443,
    path: `/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/IncomingPhoneNumbers.json`,
    method: 'POST',
    headers: {
      'Authorization': `Basic ${getAuth()}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(data),
    },
  }, data);

  if (response.status !== 201) {
    throw new Error(`Twilio purchase failed (${response.status}): ${JSON.stringify(response.body)}`);
  }

  logger.info(`[twilio-provision] Purchased number: ${response.body.phone_number} (${response.body.sid})`);
  return {
    sid: response.body.sid,
    phoneNumber: response.body.phone_number,
    friendlyName: response.body.friendly_name,
  };
}

/**
 * Create a SIP trunk.
 * @param {string} friendlyName - Name for the trunk
 * @returns {Promise<{sid, friendlyName}>}
 */
async function createSIPTrunk(friendlyName) {
  const formData = new URLSearchParams({
    FriendlyName: friendlyName,
  }).toString();

  const response = await httpsRequest({
    hostname: 'trunking.twilio.com',
    port: 443,
    path: '/v1/Trunks',
    method: 'POST',
    headers: {
      'Authorization': `Basic ${getAuth()}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(formData),
    },
  }, formData);

  if (response.status !== 201) {
    throw new Error(`SIP trunk creation failed (${response.status}): ${JSON.stringify(response.body)}`);
  }

  logger.info(`[twilio-provision] Created SIP trunk: ${response.body.sid}`);
  return { sid: response.body.sid, friendlyName: response.body.friendly_name };
}

/**
 * Add an origination URI to a SIP trunk (where calls are routed).
 * @param {string} trunkSid - SIP trunk SID
 * @param {string} sipUri - SIP URI (e.g. 'sip:agentid@in.]retellai.com')
 * @param {number} [priority=10] - Priority (lower = higher priority)
 * @param {number} [weight=10] - Weight for load balancing
 * @returns {Promise<{sid}>}
 */
async function addOriginationURI(trunkSid, sipUri, priority = 10, weight = 10) {
  const formData = new URLSearchParams({
    SipUrl: sipUri,
    Priority: String(priority),
    Weight: String(weight),
    FriendlyName: 'Retell AI',
    Enabled: 'true',
  }).toString();

  const response = await httpsRequest({
    hostname: 'trunking.twilio.com',
    port: 443,
    path: `/v1/Trunks/${trunkSid}/OriginationUrls`,
    method: 'POST',
    headers: {
      'Authorization': `Basic ${getAuth()}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(formData),
    },
  }, formData);

  if (response.status !== 201) {
    throw new Error(`Origination URI failed (${response.status}): ${JSON.stringify(response.body)}`);
  }

  logger.info(`[twilio-provision] Added origination URI to trunk ${trunkSid}: ${sipUri}`);
  return { sid: response.body.sid };
}

/**
 * Associate a phone number with a SIP trunk.
 * @param {string} trunkSid - SIP trunk SID
 * @param {string} phoneNumberSid - Twilio phone number SID
 * @returns {Promise<{sid}>}
 */
async function associateNumberWithTrunk(trunkSid, phoneNumberSid) {
  const formData = new URLSearchParams({
    PhoneNumberSid: phoneNumberSid,
  }).toString();

  const response = await httpsRequest({
    hostname: 'trunking.twilio.com',
    port: 443,
    path: `/v1/Trunks/${trunkSid}/PhoneNumbers`,
    method: 'POST',
    headers: {
      'Authorization': `Basic ${getAuth()}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(formData),
    },
  }, formData);

  if (response.status !== 201) {
    throw new Error(`Number-trunk association failed (${response.status}): ${JSON.stringify(response.body)}`);
  }

  logger.info(`[twilio-provision] Associated phone ${phoneNumberSid} with trunk ${trunkSid}`);
  return { sid: response.body.sid };
}

/**
 * Full provisioning flow: search → purchase → SIP trunk → associate.
 * Returns the unified phone number ready for calls + SMS.
 *
 * @param {object} opts
 * @param {string} opts.businessName - Business name (used for trunk naming)
 * @param {string} opts.retellSipUri - Retell SIP URI for call routing
 * @param {string} opts.smsWebhookUrl - Inbound SMS webhook URL
 * @param {string} [opts.countryCode='US'] - Country for number search
 * @param {string} [opts.areaCode] - Preferred area code
 * @param {function} [onProgress] - Callback for progress updates
 * @returns {Promise<{phoneNumber, phoneNumberSid, trunkSid}>}
 */
async function provisionUnifiedNumber(opts, onProgress = () => {}) {
  const { businessName, retellSipUri, smsWebhookUrl, countryCode = 'US', areaCode } = opts;

  // 1. Search for available numbers
  onProgress('Searching for available phone numbers...');
  const available = await searchAvailableNumbers(countryCode, {
    areaCode,
    smsEnabled: true,
    voiceEnabled: true,
    limit: 1,
  });

  if (available.length === 0) {
    throw new Error(`No available numbers found for ${countryCode}${areaCode ? ` area code ${areaCode}` : ''}`);
  }

  const phone = available[0].phoneNumber;
  onProgress(`Found available number: ${phone}`);

  // 2. Purchase the number with SMS webhook configured
  onProgress(`Purchasing number ${phone}...`);
  const purchased = await purchaseNumber(phone, smsWebhookUrl);
  onProgress(`Successfully purchased number (SID: ${purchased.sid})`);

  // 3. Create SIP trunk
  onProgress(`Creating SIP trunk for ${businessName}...`);
  const trunk = await createSIPTrunk(`ELYVN - ${businessName}`);
  onProgress(`Successfully created SIP trunk (SID: ${trunk.sid})`);

  // 4. Point trunk at Retell's SIP endpoint
  onProgress(`Configuring SIP origination URI to ${retellSipUri}...`);
  await addOriginationURI(trunk.sid, retellSipUri);

  // 5. Associate number with trunk (routes voice calls through SIP → Retell)
  onProgress('Associating phone number with SIP trunk...');
  await associateNumberWithTrunk(trunk.sid, purchased.sid);

  logger.info(`[twilio-provision] Unified number provisioned: ${purchased.phoneNumber} → SIP trunk ${trunk.sid} → ${retellSipUri}`);
  onProgress('Provisioning complete.');

  return {
    phoneNumber: purchased.phoneNumber,
    phoneNumberSid: purchased.sid,
    trunkSid: trunk.sid,
  };
}

module.exports = {
  searchAvailableNumbers,
  purchaseNumber,
  createSIPTrunk,
  addOriginationURI,
  associateNumberWithTrunk,
  provisionUnifiedNumber,
};
