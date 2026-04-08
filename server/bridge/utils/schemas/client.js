'use strict';

const { z } = require('zod');
const { UUIDSchema, PhoneSchema, EmailSchema, safeString } = require('./common');

const ClientParamsSchema = z.object({
  clientId: UUIDSchema,
});

const ClientCreateSchema = z.object({
  business_name: safeString({ max: 200 }).pipe(z.string().min(1)),
  owner_name: safeString({ max: 200 }).optional(),
  owner_phone: z.string().max(20).optional(),
  owner_email: EmailSchema.optional(),
  retell_agent_id: z.string().optional(),
  retell_phone: z.string().max(20).optional(),
  twilio_phone: z.string().max(20).optional(),
  transfer_phone: z.string().max(20).optional(),
  industry: safeString({ max: 200 }).optional(),
  timezone: z.string().max(100).optional(),
  calcom_event_type_id: z.string().optional(),
  calcom_booking_link: z.string().max(2048).optional(),
  avg_ticket: z.number().min(0).optional(),
  knowledge_base: z.any().optional(),
});

module.exports = { ClientParamsSchema, ClientCreateSchema };
