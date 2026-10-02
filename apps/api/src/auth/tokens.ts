import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256 bits, URL-safe. Used for session cookies and emailed links alike. */
export const generateToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

/**
 * Tokens are high-entropy random values, so a plain SHA-256 is enough to make a
 * database dump useless; a slow hash would only add latency to every request.
 */
export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export const hmac = (value: string, secret: string): string =>
  createHmac('sha256', secret).update(value).digest('base64url');

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export const signValue = (value: string, secret: string): string =>
  `${value}.${hmac(value, secret)}`;

/** The original value if the signature holds, otherwise null. */
export function unsignValue(signed: string, secret: string): string | null {
  const dot = signed.lastIndexOf('.');
  if (dot <= 0) return null;
  const value = signed.slice(0, dot);
  return safeEqual(signed.slice(dot + 1), hmac(value, secret)) ? value : null;
}
