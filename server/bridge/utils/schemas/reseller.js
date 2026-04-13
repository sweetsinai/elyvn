'use strict';

const { z } = require('zod');
const { safeString } = require('./common');

const ResellerRegisterSchema = z.object({
  name: safeString({ max: 200 }),
  email: z.string().email().max(254),
  password: z.string().min(8).max(128),
  brand_name: safeString({ max: 200 }).optional(),
});

const ResellerLoginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
});

const ResellerCreateClientSchema = z.object({
  business_name: safeString({ max: 200 }),
  owner_email: z.string().email().max(254),
  owner_phone: z.string().regex(/^\+?[1-9]\d{6,14}$/).optional(),
  owner_name: safeString({ max: 200 }).optional(),
  industry: safeString({ max: 100 }).optional(),
});

module.exports = { ResellerRegisterSchema, ResellerLoginSchema, ResellerCreateClientSchema };
