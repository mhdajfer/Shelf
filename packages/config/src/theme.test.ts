import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { palette, type ColorToken } from './theme.js';

const css = readFileSync(fileURLToPath(new URL('../tailwind/theme.css', import.meta.url)), 'utf8');

/** Reads `--color-x: light-dark(<light>, <dark>);` out of the @theme block. */
function readColorPairs(): Map<string, { light: string; dark: string }> {
  const open = css.indexOf('{', css.indexOf('@theme'));
  const body = css.slice(open + 1, css.indexOf('}', open));
  const pairs = new Map<string, { light: string; dark: string }>();

  const pattern = /(--color-[a-z-]+)\s*:\s*light-dark\(\s*([^,\s]+)\s*,\s*([^)\s]+)\s*\)\s*;/g;
  for (const match of body.matchAll(pattern)) {
    const [, name, light, dark] = match;
    if (name && light && dark) pairs.set(name, { light, dark });
  }
  return pairs;
}

const kebab = (token: string): string => token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const colors = readColorPairs();
const tokens = Object.keys(palette.light) as ColorToken[];

describe('theme tokens', () => {
  it('declares every color as a light-dark pair', () => {
    expect(colors.size).toBe(tokens.length);
  });

  it.each(tokens)('%s matches theme.css in both schemes', (token) => {
    const pair = colors.get(`--color-${kebab(token)}`);
    expect(pair).toBeDefined();
    expect(pair?.light).toBe(palette.light[token].toLowerCase());
    expect(pair?.dark).toBe(palette.dark[token].toLowerCase());
  });
});

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 0xff) +
    0.7152 * channel((n >> 8) & 0xff) +
    0.0722 * channel(n & 0xff)
  );
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('contrast', () => {
  const schemes = ['light', 'dark'] as const;

  it.each(schemes)('%s: every text tone clears AA on the page background', (scheme) => {
    const p = palette[scheme];
    for (const color of [p.text, p.textMuted, p.textSubtle]) {
      expect(contrast(color, p.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(color, p.surfaceRaised)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(schemes)('%s: accent works as a focus ring and as a button fill', (scheme) => {
    const p = palette[scheme];
    expect(contrast(p.accent, p.surface)).toBeGreaterThanOrEqual(3);
    expect(contrast(p.accentContrast, p.accent)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(schemes)('%s: status colors read on the page background', (scheme) => {
    const p = palette[scheme];
    for (const color of [p.danger, p.success, p.warning]) {
      expect(contrast(color, p.surface)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(schemes)('%s: borders are visible against their surface', (scheme) => {
    const p = palette[scheme];
    expect(contrast(p.borderStrong, p.surface)).toBeGreaterThanOrEqual(1.4);
  });
});
