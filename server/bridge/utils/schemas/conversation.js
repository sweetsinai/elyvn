'use strict';

const { z } = require('zod');
const { UUIDSchema, PaginationSchema, PhoneSchema, safeString } = require('./common');

const ConversationParamsSchema = z.object({
  clientId: UUIDSchema,
});

const ConversationDetailParamsSchema = z.object({
  clientId: UUIDSchema,
  conversationId: UUIDSchema,
});

const ConversationQuerySchema = PaginationSchema.extend({
  status: z.enum(['active', 'archived', 'spam', 'all']).default('all'),
  search: z.string().max(200).optional(),
});

const ConversationTimelineQuerySchema = PaginationSchema.extend({
  include_calls: z.coerce.boolean().default(true),
});

const SendMessageBodySchema = z.object({
  body: safeString({ max: 1600 }).pipe(z.string().min(1, 'Message body cannot be empty')),
  channel: z.enum(['sms']).default('sms'),
});

const MarkReadBodySchema = z.object({
  // Empty body is fine — just marks all unread as read
}).strict();

module.exports = {
  ConversationParamsSchema,
  ConversationDetailParamsSchema,
  ConversationQuerySchema,
  ConversationTimelineQuerySchema,
  SendMessageBodySchema,
  MarkReadBodySchema,
};
