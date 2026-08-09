import { z } from 'zod';

/**
 * Email is normalized here, once, at the edge: trimmed and lowercased before it
 * ever reaches the database. That plus the plain unique index on User.email is
 * what stops "Alice@x.com" and "alice@x.com" becoming two accounts.
 *
 * The pattern is deliberately loose. Strict RFC-5322 validation rejects real
 * addresses, and the only test that actually proves an address works is sending
 * mail to it.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const emailSchema = z
  .string()
  .min(3)
  .max(254)
  .transform((value) => value.trim().toLowerCase())
  .refine((value) => EMAIL_PATTERN.test(value), { message: 'Must be a valid email address' });

/**
 * Length only, no composition rules. A 10-character passphrase beats an
 * 8-character one with a symbol bolted on, and complexity rules mostly produce
 * predictable substitutions.
 */
export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(256, 'Password must be at most 256 characters');

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1, 'Display name is required').max(80),
});

export const loginSchema = z.object({
  email: emailSchema,
  // Not passwordSchema: an existing password that predates a rule change must
  // still be allowed to log in. Length rules belong on the way in, not back.
  password: z.string().min(1, 'Password is required'),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
