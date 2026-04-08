'use strict';

const { z } = require('zod');
const { EmailSchema, safeString } = require('./common');

// Loose phone — form builders send all kinds of formats; strict validation
// happens downstream in processFormSubmission via normalizePhone.
const LoosePhoneSchema = z.string().max(30).optional();

const ContactFormSchema = z.object({
  name:    safeString({ max: 200 }).optional(),
  phone:   LoosePhoneSchema,
  email:   EmailSchema.optional(),
  message: safeString({ max: 5000 }).optional(),
}).passthrough();

const LeadCaptureSchema = z.object({
  name:             safeString({ max: 200 }).optional(),
  phone:            LoosePhoneSchema,
  email:            EmailSchema.optional(),
  source:           safeString({ max: 200 }).optional(),
  service_interest: safeString({ max: 200 }).optional(),
}).passthrough();

module.exports = { ContactFormSchema, LeadCaptureSchema };
