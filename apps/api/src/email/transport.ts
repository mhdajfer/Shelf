import { Resend } from 'resend';

import { env } from '../config/env.js';
import { logger } from '../observability/logger.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailTransport {
  send: (message: EmailMessage) => Promise<void>;
}

/** Development default: the link lands in the API log instead of an inbox. */
export const consoleTransport: EmailTransport = {
  send: (message) => {
    logger.info(
      { to: message.to, subject: message.subject },
      `email (not sent, no RESEND_API_KEY):\n${message.text}`,
    );
    return Promise.resolve();
  },
};

/** Collects messages so a test can read the link out of them. */
export function createMemoryTransport(): EmailTransport & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return {
    sent,
    send: (message) => {
      sent.push(message);
      return Promise.resolve();
    },
  };
}

export function createEmailTransport(): EmailTransport {
  if (!env.RESEND_API_KEY) return consoleTransport;

  const resend = new Resend(env.RESEND_API_KEY);
  return {
    send: async (message) => {
      const { error } = await resend.emails.send({
        from: env.EMAIL_FROM,
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
      if (error !== null) throw new Error(`Resend rejected the message: ${error.message}`);
    },
  };
}
