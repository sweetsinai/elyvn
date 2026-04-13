'use strict';

const { z } = require('zod');

const UsageRecordSchema = z.object({
  type: z.enum(['call', 'sms', 'email', 'ai_decision']),
}).strict();

const OnboardingStepSchema = z.object({
  step: z.number().int().min(1).max(7),
}).strict();

const PlanUpgradeSchema = z.object({
  planId: z.enum(['growth', 'pro', 'elite']),
}).strict();

module.exports = { UsageRecordSchema, OnboardingStepSchema, PlanUpgradeSchema };
