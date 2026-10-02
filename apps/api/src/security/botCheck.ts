import { env, isTest } from '../config/env.js';
import { AppError } from '../http/errors.js';
import { logger } from '../observability/logger.js';

export interface BotCheck {
  /** False when no real Turnstile secret is configured; the UI then skips the widget. */
  enabled: boolean;
  verify: (token: string | undefined, ip: string | undefined) => Promise<void>;
}

/** Cloudflare's documented always-pass pair, shipped as the local default. */
const TEST_SECRET = '1x0000000000000000000000000000000AA';
const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export const noBotCheck: BotCheck = { enabled: false, verify: () => Promise.resolve() };

export function createBotCheck(): BotCheck {
  if (isTest || env.TURNSTILE_SECRET_KEY === TEST_SECRET) return noBotCheck;

  return {
    enabled: true,
    verify: async (token, ip) => {
      if (token === undefined || token === '') {
        throw new AppError('bad_request', 'Complete the verification challenge and try again.');
      }

      const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token });
      if (ip !== undefined) body.set('remoteip', ip);

      let success: boolean;
      try {
        const response = await fetch(VERIFY_URL, {
          method: 'POST',
          body,
          signal: AbortSignal.timeout(5000),
        });
        success = ((await response.json()) as { success?: boolean }).success === true;
      } catch (error) {
        logger.warn({ err: error }, 'turnstile verification unreachable');
        throw new AppError(
          'upstream_unavailable',
          'The verification service is not responding. Try again in a moment.',
        );
      }

      if (!success) {
        throw new AppError('bad_request', 'The verification challenge failed. Try again.');
      }
    },
  };
}
