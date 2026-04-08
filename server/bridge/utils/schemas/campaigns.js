'use strict';

const { z } = require('zod');
const { UUIDSchema, safeString } = require('./common');

const CampaignCreateSchema = z.object({
  name: safeString({ max: 255 }).pipe(z.string().min(1)),
  industry: safeString({ max: 100 }).optional(),
  city: safeString({ max: 100 }).optional(),
  prospectIds: z.array(UUIDSchema).min(1, 'At least one prospectId is required'),
});

const CampaignParamsSchema = z.object({
  campaignId: UUIDSchema,
});

module.exports = { CampaignCreateSchema, CampaignParamsSchema };
