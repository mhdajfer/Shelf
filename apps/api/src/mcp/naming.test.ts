import { describe, expect, it } from 'vitest';

import { extractVariables } from '@shelf/shared';

import { argumentsFor, decodeCursor, encodeCursor, suppliedValues } from './naming.js';

describe('argumentsFor', () => {
  it('keeps the order of first appearance and marks defaults optional', () => {
    const variables = extractVariables('{{tone:calm}} {{topic}} {{blank:}} {{topic}}');
    expect(argumentsFor(variables)).toEqual([
      { name: 'tone', required: false, description: 'Optional. Default: calm' },
      { name: 'topic', required: true },
      { name: 'blank', required: false, description: 'Optional. Empty by default.' },
    ]);
  });
});

describe('suppliedValues', () => {
  it('treats an empty string as not supplied, so the default applies', () => {
    expect(suppliedValues({ a: '', b: 'x' })).toEqual({ b: 'x' });
    expect(suppliedValues(undefined)).toEqual({});
  });
});

describe('cursors', () => {
  it('round-trip a command name', () => {
    expect(decodeCursor(encodeCursor('commit-message-2'))).toBe('commit-message-2');
  });

  it('distinguish no cursor from one this server could not have issued', () => {
    expect(decodeCursor(undefined)).toBeUndefined();
    expect(decodeCursor('not a cursor')).toBeNull();
    expect(decodeCursor(Buffer.from("x' OR 1=1").toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('Upper-Case').toString('base64url'))).toBeNull();
  });
});
