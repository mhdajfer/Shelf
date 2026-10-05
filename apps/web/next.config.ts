import { resolve } from 'node:path';

import { loadEnvConfig } from '@next/env';
import type { NextConfig } from 'next';

const isDev = process.env.NODE_ENV === 'development';

// One .env at the repo root serves both apps. Next only reads its own project
// directory, so the root file is loaded here, before anything reads process.env.
loadEnvConfig(
  resolve(process.cwd(), '../..'),
  isDev,
  { info: () => {}, error: console.error },
  true,
);

const apiOrigin = process.env.PUBLIC_API_URL ?? 'http://localhost:4000';
const webOrigin = process.env.PUBLIC_WEB_URL ?? 'http://localhost:3000';

/** Cloudflare's always-pass test key. With it the API skips the check, so the UI skips the widget. */
const TURNSTILE_TEST_SITE_KEY = '1x00000000000000000000AA';
const turnstileSiteKey =
  process.env.TURNSTILE_SITE_KEY === TURNSTILE_TEST_SITE_KEY
    ? ''
    : (process.env.TURNSTILE_SITE_KEY ?? '');

// The Content-Security-Policy is set per request in src/proxy.ts, because it
// carries a nonce. The headers here are the ones that never vary.
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  ...(isDev
    ? []
    : [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }]),
];

const nextConfig: NextConfig = {
  // The end-to-end suite builds into its own directory, so its build, which
  // points at test ports, never replaces the one `pnpm start` serves.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@shelf/shared', '@shelf/config'],

  // Inlined at build time, so the values are identical on the server and in the
  // browser bundle and no component reads process.env for anything else.
  env: {
    /** Where server components reach the API. */
    SHELF_API_ORIGIN: process.env.API_INTERNAL_URL ?? apiOrigin,
    /** Where the browser reaches it: same-origin via the dev rewrite, direct in production. */
    NEXT_PUBLIC_API_ORIGIN: isDev ? '' : apiOrigin,
    NEXT_PUBLIC_WEB_ORIGIN: webOrigin,
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: turnstileSiteKey,
  },

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
