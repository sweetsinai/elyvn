'use strict';

const { z } = require('zod');
const { UUIDSchema, PaginationSchema } = require('./common');

const MessageQuerySchema = PaginationSchema.extend({
  status: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

const MessageParamsSchema = z.object({
  clientId: UUIDSchema,
});

module.exports = { MessageQuerySchema, MessageParamsSchema };
