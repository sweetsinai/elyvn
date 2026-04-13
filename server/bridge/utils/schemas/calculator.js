'use strict';

const { z } = require('zod');
const { safeString } = require('./common');

const ROICalculatorSchema = z.object({
  industry: safeString({ max: 100 }).optional(),
  weekly_calls: z.coerce.number().int().min(0).max(10000).optional(),
  avg_ticket: z.coerce.number().min(0).max(1000000).optional(),
  plan: z.enum(['solo', 'starter', 'pro', 'premium']).optional(),
});

module.exports = { ROICalculatorSchema };
