'use strict';

const { z } = require('zod');
const { PhoneSchema, EmailSchema, safeString } = require('./common');

const OnboardSchema = z.object({
  business_name: safeString({ max: 200 }).pipe(z.string().min(1)),
  owner_name: safeString({ max: 200 }).pipe(z.string().min(1)),
  owner_phone: PhoneSchema,
  owner_email: EmailSchema,
  industry: safeString({ max: 200 }).pipe(z.string().min(1)),
  services: z.array(safeString({ max: 200 }).pipe(z.string().min(1))).min(1),
  business_hours: safeString({ max: 200 }).optional(),
  avg_ticket: z.number().min(0).optional(),
  booking_link: z.string().url().max(2048).optional(),
  faq: z.array(z.object({
    question: safeString({ max: 500 }).pipe(z.string().min(1)),
    answer: safeString({ max: 2000 }).pipe(z.string().min(1)),
  })).optional(),
});

const UpdateOnboardSchema = OnboardSchema.partial();

module.exports = { OnboardSchema, UpdateOnboardSchema };
