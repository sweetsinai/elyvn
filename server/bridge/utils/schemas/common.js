'use strict';

const { z } = require('zod');

const UUIDSchema = z.string().uuid();

const PhoneSchema = z.string().regex(/^\+?[1-9]\d{6,14}$/, 'Invalid phone number');

const EmailSchema = z.string().email().max(254);

const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});

const OffsetPaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// Reusable sanitized string type — strips HTML/XSS vectors, trims, normalizes unicode.
// Use for free-text user inputs (names, messages, notes). NOT for structured fields
// (phone, email, UUID) which have their own format validation.
const safeString = (options = {}) => z.string()
  .transform(s => s
    .replace(/<[^>]*>/g, '')           // strip HTML tags
    .replace(/javascript:/gi, '')       // strip javascript: protocol
    .replace(/data:/gi, '')             // strip data: URIs
    .trim()
    .normalize('NFC')                   // normalize unicode
  )
  .pipe(z.string().max(options.max || 1000));

module.exports = { UUIDSchema, PhoneSchema, EmailSchema, PaginationSchema, OffsetPaginationSchema, safeString };
