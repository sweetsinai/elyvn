'use strict';

const { z } = require('zod');
const { safeString } = require('./common');

const EmailUpdateSchema = z.object({
  subject: safeString({ max: 500 }).optional(),
  body: z.string().max(50000).optional(),
});

module.exports = { EmailUpdateSchema };
