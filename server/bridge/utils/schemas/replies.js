'use strict';

const { z } = require('zod');
const { UUIDSchema } = require('./common');

const ReplyEmailParamsSchema = z.object({
  emailId: UUIDSchema,
});

module.exports = { ReplyEmailParamsSchema };
