'use strict';

const { z } = require('zod');

const CreateCheckoutSchema = z.object({
  planId: z.enum(['solo', 'starter', 'pro', 'premium']),
});

module.exports = { CreateCheckoutSchema };
