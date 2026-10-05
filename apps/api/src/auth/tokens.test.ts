import { describe, expect, it } from 'vitest';

import { generateToken, hashToken, safeEqual, signValue, unsignValue } from './tokens.js';

describe('tokens', () => {
  it('generates distinct url-safe tokens', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('hashes deterministically and never returns the input', () => {
    const token = generateToken();
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toContain(token);
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('round-trips a signed value', () => {
    expect(unsignValue(signValue('guest-1', 'secret'), 'secret')).toBe('guest-1');
  });

  it('keeps a value that itself contains dots', () => {
    expect(unsignValue(signValue('a.b.c', 'secret'), 'secret')).toBe('a.b.c');
  });

  it('rejects a tampered value, a tampered signature, and a different secret', () => {
    const signed = signValue('guest-1', 'secret');
    expect(unsignValue(signed.replace('guest-1', 'guest-2'), 'secret')).toBeNull();
    expect(unsignValue(`${signed}x`, 'secret')).toBeNull();
    expect(unsignValue(signed, 'other-secret')).toBeNull();
    expect(unsignValue('no-signature', 'secret')).toBeNull();
  });

  it('compares without throwing on a length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
