import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

import { z } from 'zod';

import { oauthRepo, type Database, type OAuthClientRecord } from '@shelf/db';

import { logger } from '../observability/logger.js';
import { parseRedirectUri } from './redirects.js';

/**
 * Fetches a client ID metadata document and returns its parsed JSON, or throws.
 * Injected so tests can stand in for the client's web server.
 */
export type ClientMetadataFetcher = (url: URL) => Promise<unknown>;

const FETCH_TIMEOUT_MS = 5000;
const MAX_DOCUMENT_BYTES = 64 * 1024;
/** How long a fetched document is trusted before it is fetched again. */
const METADATA_TTL_MS = 24 * 60 * 60 * 1000;
const NAME_MAX = 100;

/**
 * Addresses a metadata fetch must never reach: loopback, private, link-local,
 * carrier-grade NAT, documentation, multicast, and reserved ranges. Without
 * this, a client ID would be a way to make the API request its own network.
 */
const RESERVED = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  RESERVED.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  RESERVED.addSubnet(network, prefix, 'ipv6');
}

/** True for an address on the public internet. Mapped IPv4 is judged as IPv4. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !RESERVED.check(address, 'ipv4');
  if (family !== 6) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped?.[1] !== undefined) return !RESERVED.check(mapped[1], 'ipv4');
  return !RESERVED.check(address, 'ipv6');
}

/**
 * Resolves as usual, then refuses if any address is not public. The socket
 * connects to the address checked here, so a DNS answer cannot change between
 * the check and the connection.
 */
const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error !== null) {
      callback(error, '', 4);
      return;
    }
    const first = addresses[0];
    if (first === undefined || addresses.some((entry) => !isPublicAddress(entry.address))) {
      callback(
        Object.assign(new Error(`${hostname} is not a public address`), { code: 'EACCES' }),
        '',
        4,
      );
      return;
    }
    if (options.all === true) {
      (callback as unknown as (error: null, addresses: LookupAddress[]) => void)(null, addresses);
    } else {
      callback(null, first.address, first.family);
    }
  });
};

/**
 * A client ID that names a metadata document: an HTTPS URL with a path, no
 * fragment, and no credentials (the 2026-07-28 client ID metadata documents).
 */
export function isMetadataClientId(value: string): boolean {
  if (value.length > 512) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.pathname !== '/' &&
      url.hash === '' &&
      !value.includes('#') &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

/**
 * Fetches over HTTPS only, from public addresses only, without following
 * redirects, within five seconds and 64 kB.
 */
export function createClientMetadataFetcher(): ClientMetadataFetcher {
  return (url) =>
    new Promise((resolve, reject) => {
      const literal = url.hostname.replace(/^\[|\]$/g, '');
      // An IP literal is connected to directly, without a lookup to check.
      if (isIP(literal) !== 0 && !isPublicAddress(literal)) {
        reject(new Error('the metadata URL is not a public address'));
        return;
      }

      const req = request(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        lookup: publicOnlyLookup,
        timeout: FETCH_TIMEOUT_MS,
      });
      const deadline = setTimeout(() => req.destroy(new Error('timed out')), FETCH_TIMEOUT_MS);

      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', (error) => {
        clearTimeout(deadline);
        reject(error);
      });
      req.on('response', (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          req.destroy(new Error(`answered ${String(res.statusCode)}`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_DOCUMENT_BYTES) {
            req.destroy(new Error('the document is too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          clearTimeout(deadline);
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
          } catch {
            reject(new Error('the document is not JSON'));
          }
        });
      });
      req.end();
    });
}

/**
 * What Shelf reads from a metadata document. Only public clients are
 * supported: there is no secret to authenticate with, so PKCE carries the
 * proof that the redeemer started the flow.
 */
const metadataDocumentSchema = z.looseObject({
  client_id: z.string(),
  client_name: z.string().optional(),
  redirect_uris: z.array(z.string()).min(1).max(10),
  token_endpoint_auth_method: z.literal('none').optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
});

/** The client's own name, trimmed of control characters and length. */
export function cleanClientName(name: string | undefined, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = (name ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  return cleaned === '' ? fallback : cleaned.slice(0, NAME_MAX);
}

/** Grant and response types, where given, must include the authorization code flow. */
export function supportsCodeFlow(input: {
  grant_types?: string[];
  response_types?: string[];
}): boolean {
  return (
    (input.grant_types === undefined || input.grant_types.includes('authorization_code')) &&
    (input.response_types === undefined || input.response_types.includes('code'))
  );
}

async function loadMetadataClient(
  db: Database,
  fetchDocument: ClientMetadataFetcher,
  clientId: string,
): Promise<OAuthClientRecord | null> {
  const cached = await oauthRepo.findClient(db, clientId);
  if (
    cached?.kind === 'metadata_document' &&
    cached.metadataFetchedAt !== null &&
    Date.now() - cached.metadataFetchedAt.getTime() < METADATA_TTL_MS
  ) {
    return cached;
  }

  const url = new URL(clientId);
  let document: z.infer<typeof metadataDocumentSchema>;
  try {
    document = metadataDocumentSchema.parse(await fetchDocument(url));
  } catch (error) {
    logger.info({ err: error, clientId }, 'client metadata document refused');
    return null;
  }
  if (
    document.client_id !== clientId ||
    !supportsCodeFlow(document) ||
    document.redirect_uris.some((uri) => parseRedirectUri(uri) === null)
  ) {
    logger.info({ clientId }, 'client metadata document does not describe this client');
    return null;
  }

  return oauthRepo.saveMetadataClient(db, {
    clientId,
    name: cleanClientName(document.client_name, url.host),
    redirectUris: document.redirect_uris,
  });
}

/**
 * The client a `client_id` names: one registered here, or one whose metadata
 * document is fetched (or read from the cache). Null for anything unknown or
 * unusable.
 */
export async function resolveClient(
  db: Database,
  fetchDocument: ClientMetadataFetcher,
  clientId: string,
): Promise<OAuthClientRecord | null> {
  if (isMetadataClientId(clientId)) return loadMetadataClient(db, fetchDocument, clientId);
  if (!z.uuid().safeParse(clientId).success) return null;
  const client = await oauthRepo.findClient(db, clientId);
  return client?.kind === 'registered' ? client : null;
}
