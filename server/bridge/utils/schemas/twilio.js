'use strict';

const { z } = require('zod');

/**
 * Schema for the Twilio inbound SMS webhook (POST /).
 *
 * Twilio sends application/x-www-form-urlencoded with PascalCase field names.
 * All Twilio fields arrive as strings; coerce where sensible.
 *
 * Required by the handler: From, Body (defaults to empty string).
 * Optional but used: To, MessageSid.
 */
const TwilioInboundSMSSchema = z.object({
  From:        z.string().min(1, 'From is required'),
  To:          z.string().optional(),
  Body:        z.string().default(''),
  MessageSid:  z.string().optional(),
  AccountSid:  z.string().optional(),
  // Common optional fields Twilio may include — passthrough keeps them available
  NumMedia:    z.string().optional(),
  NumSegments: z.string().optional(),
  SmsStatus:   z.string().optional(),
  SmsSid:      z.string().optional(),
  MessagingServiceSid: z.string().optional(),
}).passthrough(); // allow any extra Twilio fields without stripping them

module.exports = { TwilioInboundSMSSchema };
