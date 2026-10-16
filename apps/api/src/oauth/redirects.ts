/**
 * Redirect URIs: where an authorization server sends a code, and therefore
 * the thing an attacker most wants to choose. The rules follow OAuth 2.1 and
 * RFC 8252 for native apps.
 */

const MAX_LENGTH = 2000;

/** A loopback redirect may use any port: native apps pick a free one per run. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Schemes a browser handles itself. A redirect to one would run in, or read
 * from, whatever page follows it, so none of them can be a client's address.
 */
const REFUSED_SCHEMES = new Set([
  'about',
  'blob',
  'chrome',
  'data',
  'file',
  'filesystem',
  'ftp',
  'javascript',
  'mailto',
  'sms',
  'tel',
  'vbscript',
  'view-source',
  'ws',
  'wss',
]);

const isLoopback = (url: URL): boolean =>
  url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);

/**
 * A redirect URI a client may register: HTTPS anywhere, plain HTTP only to a
 * loopback address, or a private-use scheme for a native app (RFC 8252 §7.1).
 * Never a fragment or embedded credentials. Null for anything else.
 */
export function parseRedirectUri(value: string): URL | null {
  if (value.length > MAX_LENGTH || value.includes('#')) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '') return null;

  if (url.protocol === 'https:') return url.hostname === '' ? null : url;
  if (url.protocol === 'http:') return isLoopback(url) ? url : null;

  const scheme = url.protocol.slice(0, -1);
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme) || REFUSED_SCHEMES.has(scheme)) return null;
  return url;
}

/**
 * Exact string comparison, as OAuth 2.1 requires, with one exception: a
 * registered loopback URI matches the same address and path on any port.
 */
export function matchesRegistered(registered: readonly string[], presented: string): boolean {
  const url = parseRedirectUri(presented);
  if (url === null) return false;
  return registered.some((entry) => {
    if (entry === presented) return true;
    const known = parseRedirectUri(entry);
    return (
      known !== null &&
      isLoopback(known) &&
      isLoopback(url) &&
      known.hostname === url.hostname &&
      known.pathname === url.pathname &&
      known.search === url.search
    );
  });
}

/** What the consent page says about where approving sends the browser. */
export function describeRedirect(value: string): {
  kind: 'loopback' | 'web' | 'app';
  target: string;
} {
  const url = new URL(value);
  if (isLoopback(url)) return { kind: 'loopback', target: 'an app on this computer' };
  if (url.protocol === 'https:') return { kind: 'web', target: url.host };
  return { kind: 'app', target: `${url.protocol}//` };
}

/** The redirect URI with the response parameters added, keeping any query it already has. */
export function withParams(
  base: string,
  params: Record<string, string | null | undefined>,
): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}
