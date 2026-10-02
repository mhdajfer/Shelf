import { z } from 'zod';

import { LIMITS, type UserRole } from '../constants.js';

export const PASSWORD_MIN = 8;
/** Argon2 input is bounded so a megabyte "password" cannot be used to burn CPU. */
export const PASSWORD_MAX = 128;
export const HANDLE_MIN = 3;
export const NAME_MAX = 80;

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('Enter a valid email address.').max(254, 'That email address is too long.'));

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN, `Use at least ${String(PASSWORD_MIN)} characters.`)
  .max(PASSWORD_MAX, `Use at most ${String(PASSWORD_MAX)} characters.`);

export const handleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(
    z
      .string()
      .min(HANDLE_MIN, `Use at least ${String(HANDLE_MIN)} characters.`)
      .max(LIMITS.handleMax, `Use at most ${String(LIMITS.handleMax)} characters.`)
      .regex(/^[a-z0-9_]+$/, 'Use lowercase letters, numbers, and underscores.')
      .refine((value) => !value.startsWith('guest'), 'Handles cannot start with "guest".'),
  );

const nameSchema = z
  .string()
  .trim()
  .max(NAME_MAX, `Use at most ${String(NAME_MAX)} characters.`);

export const signupSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: nameSchema.optional(),
  turnstileToken: z.string().max(4096).optional(),
});
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password.').max(PASSWORD_MAX),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const forgotPasswordSchema = z.object({ email: emailSchema });
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

const tokenSchema = z
  .string()
  .min(20, 'That link is not valid.')
  .max(200, 'That link is not valid.');

export const resetPasswordSchema = z.object({ token: tokenSchema, password: passwordSchema });
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const verifyEmailSchema = z.object({ token: tokenSchema });
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;

export const updateProfileSchema = z.object({
  name: nameSchema.optional(),
  handle: handleSchema.optional(),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().max(PASSWORD_MAX).optional(),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/** What the API tells a browser about the signed-in user. */
export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  handle: string;
  role: UserRole;
  emailVerified: boolean;
  /** False for Google-only accounts, which have no password to change. */
  hasPassword: boolean;
}

/** `GET /auth/me`: everything the web app needs to draw its chrome. */
export interface MeDto {
  user: SessionUser | null;
  guest: { handle: string } | null;
  csrfToken: string;
  features: {
    /** False when Google credentials are not configured; the button is hidden. */
    google: boolean;
    /** True when a real Turnstile secret is configured and tokens are required. */
    botCheck: boolean;
  };
}

export interface PublicProfileDto {
  handle: string;
  name: string | null;
  joinedAt: string;
  publicPromptCount: number;
}
