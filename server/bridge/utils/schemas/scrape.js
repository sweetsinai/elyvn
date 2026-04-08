'use strict';

const { z } = require('zod');

const ScrapeSchema = z.object({
  industry: z.string().min(1).max(100),
  city: z.string().min(1).max(100),
  state: z.string().max(100).optional(),
  country: z.string().max(100).optional(),
  maxResults: z.coerce.number().int().min(1).max(20).default(20),
});

const BlastSchema = z.object({
  subject: z.string().min(1).max(300),
  body: z.string().min(1).max(5000),
  filter: z.object({
    industry: z.string().max(100).optional(),
    city: z.string().max(100).optional(),
    status: z.string().max(50).optional(),
  }).optional(),
  maxSend: z.coerce.number().int().min(1).max(200).default(50),
});

module.exports = { ScrapeSchema, BlastSchema };
