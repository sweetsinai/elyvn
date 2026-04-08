'use strict';

const { z } = require('zod');

const CreateCheckoutSchema = z.object({
  planId: z.enum(['starter', 'growth', 'scale']),
});

module.exports = { CreateCheckoutSchema };
