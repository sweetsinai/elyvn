'use strict';

const { z } = require('zod');
const { UUIDSchema, safeString } = require('./common');

const FormSubmissionSchema = z.object({
  client_id: UUIDSchema.optional(),
  clientId: UUIDSchema.optional(),
  name: safeString({ max: 200 }).optional(),
  first_name: safeString({ max: 200 }).optional(),
  last_name: safeString({ max: 200 }).optional(),
  phone: z.string().max(20).optional(),
  email: z.string().max(254).optional(),
  message: safeString({ max: 5000 }).optional(),
  service: safeString({ max: 200 }).optional(),
  utm_source: safeString({ max: 200 }).optional(),
  source: safeString({ max: 200 }).optional(),
}).passthrough(); // Allow additional fields from various form builders

const FormParamsSchema = z.object({
  clientId: UUIDSchema,
});

module.exports = { FormSubmissionSchema, FormParamsSchema };
