'use strict';

const { z } = require('zod');
const { safeString, PhoneSchema } = require('./common');

const optionalPhone = z.union([
  PhoneSchema,
  z.literal(''),
]).optional();

const optionalUrl = z.union([
  z.string().url().max(500),
  z.literal(''),
]).optional();

const SettingsUpdateSchema = z.object({
  business_name: safeString({ max: 200 }).optional(),
  owner_name: safeString({ max: 200 }).optional(),
  owner_phone: PhoneSchema.optional(),
  industry: safeString({ max: 100 }).optional(),
  timezone: safeString({ max: 100 }).optional(),
  avg_ticket: z.number().min(0).max(100000).optional(),
  retell_voice: safeString({ max: 100 }).optional(),
  retell_language: safeString({ max: 20 }).optional(),
  transfer_phone: optionalPhone,
  whatsapp_phone: optionalPhone,
  calcom_booking_link: optionalUrl,
  calcom_event_type_id: safeString({ max: 200 }).optional(),
  google_review_link: optionalUrl,
  notification_mode: z.enum(['all', 'digest']).optional(),
  is_active: z.union([z.boolean(), z.number().int().min(0).max(1)]).optional(),
  auto_followup_enabled: z.union([z.boolean(), z.number().int().min(0).max(1)]).optional(),
  lead_webhook_url: optionalUrl,
  booking_webhook_url: optionalUrl,
  call_webhook_url: optionalUrl,
  sms_webhook_url: optionalUrl,
  stage_change_webhook_url: optionalUrl,
}).passthrough();

module.exports = { SettingsUpdateSchema };
