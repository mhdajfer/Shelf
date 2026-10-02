import { NextResponse, type NextRequest } from 'next/server';

const isDev = process.env.NODE_ENV === 'development';
const apiOrigin = process.env.NEXT_PUBLIC_API_ORIGIN ?? '';
const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

/**
 * A per-request Content-Security-Policy with a script nonce.
 *
 * Scripts run only if they carry this request's nonce, or were loaded by one
 * that does ('strict-dynamic'). Next stamps the nonce on its own scripts when it
 * sees the policy on the request, so there is no 'unsafe-inline' for scripts and
 * an injected <script> tag does not execute.
 *
 * Styles keep 'unsafe-inline': CodeMirror and the toast library inject style
 * elements at runtime, and Radix positions popovers with inline style
 * attributes. Injected CSS cannot run code, so the weaker rule is confined to
 * the lower-risk half of the policy.
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');

  const policy = [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    // React needs eval in development only, to rebuild server stack traces.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    `frame-src ${TURNSTILE_ORIGIN}`,
    `connect-src 'self'${apiOrigin === '' ? '' : ` ${apiOrigin}`}${isDev ? ' ws: http://localhost:*' : ''}`,
    ...(isDev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');

  // On the request, so server components can read the nonce and Next can apply
  // it; on the response, so the browser enforces it.
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', policy);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', policy);
  return response;
}

export const config = {
  matcher: [
    {
      // Documents only. Static assets and the dev-time API rewrite need no
      // policy, and a prefetch is not a navigation.
      source: '/((?!api/|_next/static|_next/image|icon.svg|robots.txt|sitemap.xml).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
