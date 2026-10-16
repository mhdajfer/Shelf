import { env } from '../config/env.js';
import { MCP_PATH } from '../mcp/path.js';
import { createClientMetadataFetcher, type ClientMetadataFetcher } from './clients.js';

export const OAUTH_PREFIX = '/api/v1/oauth';
export const PROTECTED_RESOURCE_METADATA_PATH = `/.well-known/oauth-protected-resource${MCP_PATH}`;
export const AUTHORIZATION_SERVER_METADATA_PATH = '/.well-known/oauth-authorization-server';

/**
 * Shelf is both the authorization server and the resource server it protects,
 * so every URL here derives from the API's public origin. The issuer has no
 * trailing slash: clients compare it with `iss` as a plain string.
 */
export interface OAuthConfig {
  issuer: string;
  /** The RFC 8707 resource every token is bound to: the MCP endpoint. */
  resource: string;
  resourceMetadataUrl: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  revocationEndpoint: string;
  /** The web app's consent page, where the authorize endpoint sends the browser. */
  consentUrl: string;
  /** The web app's setup guide for MCP clients. */
  documentationUrl: string;
  fetchClientMetadata: ClientMetadataFetcher;
}

/** Overrides for tests, which listen on an ephemeral port rather than the configured one. */
export interface OAuthOptions {
  apiUrl?: string;
  webUrl?: string;
  fetchClientMetadata?: ClientMetadataFetcher;
}

export function resolveOAuthConfig(options: OAuthOptions = {}): OAuthConfig {
  const issuer = new URL(options.apiUrl ?? env.PUBLIC_API_URL).origin;
  const web = new URL(options.webUrl ?? env.PUBLIC_WEB_URL).origin;
  return {
    issuer,
    resource: `${issuer}${MCP_PATH}`,
    resourceMetadataUrl: `${issuer}${PROTECTED_RESOURCE_METADATA_PATH}`,
    authorizationEndpoint: `${issuer}${OAUTH_PREFIX}/authorize`,
    tokenEndpoint: `${issuer}${OAUTH_PREFIX}/token`,
    registrationEndpoint: `${issuer}${OAUTH_PREFIX}/register`,
    revocationEndpoint: `${issuer}${OAUTH_PREFIX}/revoke`,
    consentUrl: `${web}/oauth/consent`,
    documentationUrl: `${web}/docs/mcp`,
    fetchClientMetadata: options.fetchClientMetadata ?? createClientMetadataFetcher(),
  };
}

/** Resource indicators compare as URLs written either with or without one trailing slash. */
export function sameResource(a: string, b: string): boolean {
  const trim = (value: string): string => (value.endsWith('/') ? value.slice(0, -1) : value);
  return trim(a) === trim(b);
}
