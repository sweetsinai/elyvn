'use strict';

const { z } = require('zod');

const CreateCheckoutSchema = z.object({
  planId: z.enum(['starter', 'pro', 'premium']),
});

module.exports = { CreateCheckoutSchema };
