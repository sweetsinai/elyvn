'use strict';

const { z } = require('zod');

const WebhookTestSchema = z.object({
  event_type: z.enum([
    'call_ended',
    'lead.created',
    'lead.stage_changed',
    'sms.received',
    'sms.sent',
    'booking.created',
  ]),
}).strict();

module.exports = { WebhookTestSchema };
