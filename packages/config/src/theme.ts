/**
 * Design tokens as plain values.
 *
 * `tailwind/theme.css` is the source of truth for the running UI; this module
 * mirrors it for contexts that cannot read a stylesheet, chiefly `next/og`
 * image generation, which needs literal colors at render time. The two are kept
 * in sync by `theme.test.ts`.
 */

export const palette = {
  light: {
    surface: '#FAFAF7',
    surfaceRaised: '#FFFFFF',
    surfaceSunken: '#F3F2EC',
    border: '#E3E1D8',
    borderStrong: '#CFCCC0',
    text: '#1A1A17',
    textMuted: '#565346',
    textSubtle: '#6E6B5B',
    accent: '#2B4ACB',
    accentHover: '#2340B4',
    accentContrast: '#FFFFFF',
    danger: '#B4301A',
    success: '#2E6B45',
    warning: '#8A5A12',
  },
  dark: {
    surface: '#161614',
    surfaceRaised: '#1E1E1B',
    surfaceSunken: '#121210',
    border: '#2E2E29',
    borderStrong: '#44443D',
    text: '#EDEBE4',
    textMuted: '#A8A496',
    textSubtle: '#918D7E',
    accent: '#7D93F0',
    accentHover: '#93A6F5',
    accentContrast: '#0F1020',
    danger: '#F08C78',
    success: '#6FBF8E',
    warning: '#D8A24E',
  },
} as const;

export type ColorScheme = keyof typeof palette;
export type ColorToken = keyof (typeof palette)['light'];

export const radius = {
  sm: '4px',
  md: '8px',
  lg: '12px',
} as const;

/** Motion stays inside 120-180ms; anything slower reads as sluggish here. */
export const motion = {
  fast: '120ms',
  base: '150ms',
  slow: '180ms',
  easing: 'cubic-bezier(0.2, 0, 0, 1)',
} as const;

export const fonts = {
  sans: 'Geist, "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif',
  mono: '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
} as const;
