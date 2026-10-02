import { env } from '../config/env.js';
import type { EmailMessage } from './transport.js';

const PRODUCT = 'Shelf';

export function verificationEmail(to: string, token: string): EmailMessage {
  const link = `${env.PUBLIC_WEB_URL}/verify-email?token=${encodeURIComponent(token)}`;
  return {
    to,
    subject: `Confirm your email for ${PRODUCT}`,
    text: [
      `Confirm this address to finish setting up your ${PRODUCT} account:`,
      '',
      link,
      '',
      'The link works once and expires in 24 hours.',
      `If you did not create a ${PRODUCT} account, you can ignore this email.`,
    ].join('\n'),
  };
}

export function passwordResetEmail(to: string, token: string): EmailMessage {
  const link = `${env.PUBLIC_WEB_URL}/reset-password?token=${encodeURIComponent(token)}`;
  return {
    to,
    subject: `Reset your ${PRODUCT} password`,
    text: [
      'Use this link to choose a new password:',
      '',
      link,
      '',
      'The link works once and expires in 1 hour.',
      'If you did not ask for this, you can ignore this email. Your password has not changed.',
    ].join('\n'),
  };
}
