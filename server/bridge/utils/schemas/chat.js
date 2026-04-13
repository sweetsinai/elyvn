'use strict';

const { z } = require('zod');
const { safeString } = require('./common');

const ChatSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: safeString({ max: 5000 }),
  })).min(1).max(50),
  clientId: z.string().uuid().optional(),
});

module.exports = { ChatSchema };
