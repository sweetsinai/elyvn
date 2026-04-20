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
  business_address: safeString({ max: 500 }).optional(),
  website: z.string().max(500).optional(),
  avg_ticket: z.number().min(0).optional(),
  ticket_price: z.number().min(0).optional(),
  booking_link: z.string().max(2048).optional(),
  faq: z.array(z.object({
    question: safeString({ max: 500 }).pipe(z.string().min(1)),
    answer: safeString({ max: 2000 }).pipe(z.string().min(1)),
  })).optional(),
});

const UpdateOnboardSchema = OnboardSchema.partial();

module.exports = { OnboardSchema, UpdateOnboardSchema };
