'use strict';

const { z } = require('zod');
const { OffsetPaginationSchema, PhoneSchema } = require('./common');

const CallQuerySchema = OffsetPaginationSchema.extend({
  outcome: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
});

const TransferSchema = z.object({
  transfer_phone: PhoneSchema.optional(),
}).strict();

module.exports = { CallQuerySchema, TransferSchema };
