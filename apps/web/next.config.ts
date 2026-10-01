import type { NextConfig } from 'next';

const isDev = process.env.NODE_ENV === 'development';
const apiOrigin = process.env.PUBLIC_API_URL ?? 'http://localhost:4000';

const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

/**
 * Baseline policy. Inline styles are unavoidable with Next's streaming style
 * injection; inline scripts are still permitted here and get a nonce in the
 * hardening pass, along with 'strict-dynamic'.
 */
const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''} ${TURNSTILE_ORIGIN}`,
  `frame-src ${TURNSTILE_ORIGIN}`,
  `connect-src 'self' ${apiOrigin}${isDev ? ' ws: http://localhost:*' : ''}`,
  'upgrade-insecure-requests',
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  ...(isDev
    ? []
    : [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }]),
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@shelf/shared', '@shelf/config'],

  headers() {
    return Promise.resolve([{ source: '/:path*', headers: securityHeaders }]);
  },

  /**
   * Development only. In production the browser calls the API origin directly
   * so SSE streams are not subject to a platform proxy timeout; the session
   * cookie is shared through a parent-domain scope instead of a rewrite.
   */
  rewrites() {
    if (!isDev) return Promise.resolve([]);
    return Promise.resolve([{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }]);
  },
};

export default nextConfig;
