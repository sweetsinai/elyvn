const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const path = require('path');
const fsPromises = require('fs').promises;
const { isValidUUID, isValidPhone, isValidEmail, isValidURL, sanitizeString } = require('../utils/validate');
const { logger } = require('../utils/logger');

// Rate limiting for onboarding
const onboardRateLimits = new Map();
const ONBOARD_RATE_LIMIT = 5; // max onboards per minute per IP
const ONBOARD_RATE_WINDOW = 60000; // 1 minute

function onboardRateLimit(req, res, next) {
  const key = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const record = onboardRateLimits.get(key);

  if (record) {
    // Clean old entries
    record.timestamps = record.timestamps.filter(t => now - t < ONBOARD_RATE_WINDOW);
    if (record.timestamps.length >= ONBOARD_RATE_LIMIT) {
      const { logger } = require('../utils/logger');
      logger.warn(`[onboard] Rate limit exceeded for ${key}`);
      return res.status(429).json({ error: 'Too many onboarding requests. Please try again later.' });
    }
    record.timestamps.push(now);
  } else {
    onboardRateLimits.set(key, { timestamps: [now] });
  }

  // Cleanup old entries periodically to prevent memory leak
  if (onboardRateLimits.size > 1000) {
    const keysToDelete = [];
    for (const [k, v] of onboardRateLimits) {
      const latest = v.timestamps[v.timestamps.length - 1] || 0;
      if (now - latest > ONBOARD_RATE_WINDOW) keysToDelete.push(k);
    }
    for (const k of keysToDelete) onboardRateLimits.delete(k);
  }

  next();
}


/**
 * POST /api/onboard
 *
 * Complete client onboarding in one atomic call.
 *
 * Body:
 *   {
 *     business_name: string (required),
 *     owner_name: string (required),
 *     owner_phone: string (required),
 *     owner_email: string (required, valid email),
 *     industry: string (required),
 *     services: [string] (array, required),
 *     business_hours: string (optional, e.g. "Mon-Fri 8am-6pm"),
 *     avg_ticket: number (optional, average job value),
 *     booking_link: string (optional, Cal.com link),
 *     faq: [{question: string, answer: string}] (optional)
 *   }
 *
 * Returns:
 *   {
 *     success: true,
 *     client_id: string (UUID),
 *     status: "active",
 *     kb_generated: true,
 *     next_steps: [string],
 *     webhook_urls: {...},
 *     embed_code: string (HTML snippet)
 *   }
 */
router.post('/onboard', onboardRateLimit, async (req, res) => {
  try {
    const db = req.app.locals.db;

    // Extract and validate request body
    const {
      business_name,
      owner_name,
      owner_phone,
      owner_email,
      industry,
      services,
      business_hours,
      avg_ticket,
      booking_link,
      faq
    } = req.body;

    // Validate required fields
    const errors = [];

    if (!business_name || typeof business_name !== 'string' || !business_name.trim()) {
      errors.push('business_name is required and must be a non-empty string');
    }

    if (!owner_name || typeof owner_name !== 'string' || !owner_name.trim()) {
      errors.push('owner_name is required and must be a non-empty string');
    }

    if (!owner_phone || typeof owner_phone !== 'string' || !owner_phone.trim()) {
      errors.push('owner_phone is required and must be a non-empty string');
    } else if (!isValidPhone(owner_phone)) {
      errors.push('owner_phone must be a valid phone number');
    }

    if (!owner_email || typeof owner_email !== 'string' || !isValidEmail(owner_email)) {
      errors.push('owner_email is required and must be a valid email address');
    }

    if (!industry || typeof industry !== 'string' || !industry.trim()) {
      errors.push('industry is required and must be a non-empty string');
    }

    if (!Array.isArray(services) || services.length === 0) {
      errors.push('services is required and must be a non-empty array of strings');
    }

    if (services && !services.every(s => typeof s === 'string' && s.trim())) {
      errors.push('all services must be non-empty strings');
    }

    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: errors
      });
    }

    // Validate optional fields if provided
    if (avg_ticket !== undefined && (typeof avg_ticket !== 'number' || avg_ticket < 0)) {
      return res.status(400).json({
        success: false,
        error: 'avg_ticket must be a non-negative number'
      });
    }

    if (booking_link && typeof booking_link !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'booking_link must be a string'
      });
    }

    if (booking_link && !isValidURL(booking_link)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid booking link URL'
      });
    }

    if (faq && !Array.isArray(faq)) {
      return res.status(400).json({
        success: false,
        error: 'faq must be an array of {question, answer} objects'
      });
    }

    if (faq) {
      for (const item of faq) {
        if (!item.question || !item.answer || typeof item.question !== 'string' || typeof item.answer !== 'string') {
          return res.status(400).json({
            success: false,
            error: 'each FAQ item must have "question" and "answer" as non-empty strings'
          });
        }
      }
    }

    // Check if email already exists (prevent duplicate accounts)
    const existingClient = db.prepare(
      'SELECT id FROM clients WHERE owner_email = ?'
    ).get(owner_email.toLowerCase().trim());

    if (existingClient) {
      return res.status(409).json({
        success: false,
        error: 'An account with this email already exists'
      });
    }

    // Sanitize inputs
    const sanitized = {
      business_name: sanitizeString(business_name),
      owner_name: sanitizeString(owner_name),
      owner_phone: sanitizeString(owner_phone),
      owner_email: owner_email.toLowerCase().trim(),
      industry: sanitizeString(industry),
      services: services.map(s => sanitizeString(s)),
      business_hours: business_hours ? sanitizeString(business_hours) : null,
      avg_ticket: avg_ticket || 0,
      booking_link: booking_link ? sanitizeString(booking_link) : null,
      faq: faq ? faq.map(item => ({
        question: sanitizeString(item.question),
        answer: sanitizeString(item.answer)
      })) : []
    };

    // Generate client ID
    const clientId = randomUUID();
    const now = new Date().toISOString();

    // Determine booking_info from provided data
    let bookingInfo = 'Booking information not configured';
    if (sanitized.booking_link) {
      bookingInfo = `Schedule a service: ${sanitized.booking_link}`;
    } else if (sanitized.business_hours) {
      bookingInfo = `We're available ${sanitized.business_hours}`;
    }

    // Generate knowledge base JSON
    const knowledgeBase = {
      client_id: clientId,
      business_name: sanitized.business_name,
      greeting: `Thank you for calling ${sanitized.business_name}! How can I help you today?`,
      services: sanitized.services,
      industry: sanitized.industry,
      business_hours: sanitized.business_hours || 'Not specified',
      booking_info: bookingInfo,
      faq: sanitized.faq,
      escalation_phrases: [
        'speak to a person',
        'talk to someone',
        'manager',
        'complaint',
        'human',
        'representative'
      ],
      generated_at: now
    };

    // Prepare KB file path
    const kbDir = path.join(__dirname, '../../mcp/knowledge_bases');
    const kbPath = `server/mcp/knowledge_bases/${clientId}.json`;
    const kbAbsPath = path.join(__dirname, '../../mcp/knowledge_bases', `${clientId}.json`);

    // Create directory and write KB file
    await fsPromises.mkdir(kbDir, { recursive: true });
    await fsPromises.writeFile(kbAbsPath, JSON.stringify(knowledgeBase, null, 2));

    // Insert client record into database
    db.prepare(`
      INSERT INTO clients (
        id, business_name, owner_name, owner_phone, owner_email,
        industry, avg_ticket, kb_path, timezone, is_active,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      clientId,
      sanitized.business_name,
      sanitized.owner_name,
      sanitized.owner_phone,
      sanitized.owner_email,
      sanitized.industry,
      sanitized.avg_ticket,
      kbPath,
      'America/New_York',
      1,
      now,
      now
    );

    // Determine base URL for webhooks
    const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : process.env.BASE_URL || `http://localhost:${process.env.PORT || 3001}`;

    // Generate embed code for website
    const embedCode = `<script>
  (function() {
    const clientId = "${clientId}";
    const baseUrl = "${baseUrl}";
    // Load ELYVN chat widget
    const script = document.createElement('script');
    script.src = baseUrl + '/elyvn-widget.js';
    script.dataset.clientId = clientId;
    document.head.appendChild(script);
  })();
</script>`;

    // Prepare response
    const response = {
      success: true,
      client_id: clientId,
      status: 'active',
      kb_generated: true,
      kb_path: kbPath,
      next_steps: [
        '1. Connect Retell AI voice agent: Visit https://retell.ai and create an agent with the provided knowledge base',
        '2. Configure Telnyx: Add SMS phone number and set webhook to ' + baseUrl + '/webhooks/telnyx',
        '3. Set up Telegram bot: Configure your bot webhook at ' + baseUrl + '/webhooks/telegram',
        '4. Add Cal.com booking link: Update client record with calcom_booking_link for auto-booking',
        '5. Embed on website: Add the provided embed code to your website',
        '6. Test the system: Make a call or send an SMS to verify integration'
      ],
      webhook_urls: {
        telnyx: baseUrl + '/webhooks/telnyx',
        telegram: baseUrl + '/webhooks/telegram',
        forms: baseUrl + '/webhooks/form',
        retell: baseUrl + '/webhooks/retell'
      },
      embed_code: embedCode,
      api_endpoints: {
        get_stats: `/api/stats/${clientId}`,
        get_calls: `/api/calls/${clientId}`,
        get_leads: `/api/leads/${clientId}`,
        get_messages: `/api/messages/${clientId}`,
        get_bookings: `/api/bookings/${clientId}`,
        update_client: `/api/clients/${clientId}`
      },
      client_details: {
        id: clientId,
        business_name: sanitized.business_name,
        owner_name: sanitized.owner_name,
        owner_email: sanitized.owner_email,
        industry: sanitized.industry,
        services: sanitized.services,
        created_at: now
      }
    };

    res.status(201).json(response);

  } catch (err) {
    logger.error('[onboard] Error:', err);
    res.status(500).json({
      success: false,
      error: 'Onboarding failed',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

module.exports = router;
