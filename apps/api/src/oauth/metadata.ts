import type { OAuthMetadata, OAuthProtectedResourceMetadata } from '@modelcontextprotocol/server';

import { ACCESS_SCOPES } from '@shelf/shared';

import type { OAuthConfig } from './config.js';

/**
 * RFC 9728: what an MCP client reads first, from the URL in the 401 challenge,
 * to learn which authorization server protects `/mcp`.
 */
export function protectedResourceMetadata(config: OAuthConfig): OAuthProtectedResourceMetadata {
  return {
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: [...ACCESS_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Shelf',
    resource_documentation: config.documentationUrl,
  };
}

/**
 * RFC 8414. Public clients only (PKCE with S256, no client secrets), client
 * ID metadata documents preferred over dynamic registration, and `iss` on
 * every authorization response (RFC 9207).
 */
export function authorizationServerMetadata(config: OAuthConfig): OAuthMetadata {
  return {
    issuer: config.issuer,
    authorization_endpoint: config.authorizationEndpoint,
    token_endpoint: config.tokenEndpoint,
    registration_endpoint: config.registrationEndpoint,
    revocation_endpoint: config.revocationEndpoint,
    scopes_supported: [...ACCESS_SCOPES],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: config.documentationUrl,
  };
}
