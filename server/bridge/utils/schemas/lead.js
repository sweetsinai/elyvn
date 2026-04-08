'use strict';

const { z } = require('zod');
const { PhoneSchema, OffsetPaginationSchema, safeString } = require('./common');

const LeadCreateSchema = z.object({
  phone: PhoneSchema,
  name: safeString({ max: 200 }).optional(),
  source: safeString({ max: 200 }).optional(),
});

const LeadUpdateSchema = z.object({
  stage: z.enum(['new', 'contacted', 'interested', 'qualified', 'booked', 'completed', 'not_interested', 'lost']).optional(),
  name: safeString({ max: 200 }).optional(),
  revenue_closed: z.number().nonnegative().optional(),
  job_value: z.number().nonnegative().optional(),
});

const LeadQuerySchema = OffsetPaginationSchema.extend({
  search: safeString({ max: 200 }).optional(),
  stage: z.string().optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
});

module.exports = { LeadCreateSchema, LeadUpdateSchema, LeadQuerySchema };
