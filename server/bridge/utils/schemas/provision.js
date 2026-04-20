'use strict';

const { z } = require('zod');
const { safeString } = require('./common');

const ProvisionSchema = z.object({
  business_name: safeString({ max: 200 }),
  owner_name: safeString({ max: 200 }).optional(),
  owner_phone: z.string().max(30),
  owner_email: z.string().email().max(254).optional(),
  industry: safeString({ max: 100 }).optional(),
  avg_ticket: z.number().min(0).max(100000).optional(),
  ticket_price: z.number().min(0).max(100000).optional(),
  business_address: safeString({ max: 500 }).optional(),
  website: safeString({ max: 500 }).optional(),
  booking_link: safeString({ max: 2048 }).optional(),
  plan: z.enum(['solo', 'starter', 'pro', 'premium']),
  timezone: safeString({ max: 100 }).optional(),
  area_code: z.string().max(10).optional(),
  knowledge_base: z.any().optional(),
  retell_voice: safeString({ max: 100 }).optional(),
  retell_language: safeString({ max: 50 }).optional(),
}).passthrough();

module.exports = { ProvisionSchema };
