'use strict';

const { z } = require('zod');
const { EmailSchema, safeString } = require('./common');

const LoginSchema = z.object({
  email: EmailSchema,
  password: z.string().min(8).max(128),
});

const SignupSchema = z.object({
  email: EmailSchema,
  password: z.string().min(8).max(128),
  business_name: safeString({ max: 200 }).pipe(z.string().min(1)),
  owner_name: safeString({ max: 200 }).optional(),
  owner_phone: z.string().max(20).optional(),
});

const ForgotPasswordSchema = z.object({
  email: EmailSchema,
});

const ResetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8).max(128),
});

module.exports = { LoginSchema, SignupSchema, ForgotPasswordSchema, ResetPasswordSchema };
