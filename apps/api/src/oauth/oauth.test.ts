import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  cleanClientName,
  createClientMetadataFetcher,
  isMetadataClientId,
  isPublicAddress,
} from './clients.js';
import { resolveOAuthConfig, sameResource } from './config.js';
import { authorizationServerMetadata, protectedResourceMetadata } from './metadata.js';
import { requestedScopes, verifyPkce } from './pkce.js';
import { describeRedirect, matchesRegistered, parseRedirectUri, withParams } from './redirects.js';

describe('redirect URIs', () => {
  it('may be HTTPS, loopback HTTP, or a native app’s own scheme', () => {
    for (const uri of [
      'https://client.example/callback',
      'http://127.0.0.1/callback',
      'http://localhost:8080/cb',
      'http://[::1]:3000/cb',
      'cursor://anysphere.cursor-retrieval/oauth/callback',
      'com.example.app:/oauth2redirect',
    ]) {
      expect(parseRedirectUri(uri), uri).not.toBeNull();
    }
  });

  it('may not be plain HTTP elsewhere, carry a fragment or credentials, or use a browser scheme', () => {
    for (const uri of [
      'http://client.example/callback',
      'http://127.0.0.1.nip.io/callback',
      'https://client.example/callback#fragment',
      'https://user:pass@client.example/callback',
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,hi',
      'file:///etc/passwd',
      'vbscript:msgbox',
      'not a url',
      `https://client.example/${'a'.repeat(2000)}`,
    ]) {
      expect(parseRedirectUri(uri), uri).toBeNull();
    }
  });

  it('match exactly, except that loopback ignores the port', () => {
    const registered = ['https://client.example/cb', 'http://127.0.0.1/callback'];
    expect(matchesRegistered(registered, 'https://client.example/cb')).toBe(true);
    expect(matchesRegistered(registered, 'http://127.0.0.1:53682/callback')).toBe(true);

    expect(matchesRegistered(registered, 'https://client.example/cb/')).toBe(false);
    expect(matchesRegistered(registered, 'https://client.example:8443/cb')).toBe(false);
    expect(matchesRegistered(registered, 'https://client.example/cb?x=1')).toBe(false);
    expect(matchesRegistered(registered, 'http://localhost:53682/callback')).toBe(false);
    expect(matchesRegistered(registered, 'http://127.0.0.1:53682/other')).toBe(false);
  });

  it('are described for the consent page by where they lead', () => {
    expect(describeRedirect('http://127.0.0.1:5000/cb')).toEqual({
      kind: 'loopback',
      target: 'an app on this computer',
    });
    expect(describeRedirect('https://vscode.dev/redirect')).toEqual({
      kind: 'web',
      target: 'vscode.dev',
    });
    expect(describeRedirect('cursor://anysphere.cursor-retrieval/cb')).toEqual({
      kind: 'app',
      target: 'cursor://',
    });
  });

  it('keep their own query when the response is added', () => {
    expect(withParams('https://c.example/cb?tenant=1', { code: 'a b', state: null })).toBe(
      'https://c.example/cb?tenant=1&code=a+b',
    );
  });
});

describe('PKCE', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  it('accepts the verifier the challenge was made from', () => {
    expect(verifyPkce(verifier, challenge)).toBe(true);
  });

  it('refuses any other verifier, and the plain method’s shortcut', () => {
    expect(verifyPkce(`${verifier.slice(0, -1)}A`, challenge)).toBe(false);
    // With the plain method the challenge is the verifier itself.
    expect(verifyPkce(verifier, verifier)).toBe(false);
    expect(verifyPkce('short', createHash('sha256').update('short').digest('base64url'))).toBe(
      false,
    );
  });
});

describe('scopes', () => {
  it('always include read, add write only when asked, and ignore the rest', () => {
    expect(requestedScopes(undefined)).toEqual(['prompts:read']);
    expect(requestedScopes('prompts:write')).toEqual(['prompts:read', 'prompts:write']);
    expect(requestedScopes('openid offline_access prompts:read')).toEqual(['prompts:read']);
  });
});

describe('client metadata documents', () => {
  it('are named by an HTTPS URL with a path', () => {
    expect(isMetadataClientId('https://claude.ai/oauth/claude-code-client-metadata')).toBe(true);
    for (const value of [
      'https://claude.ai/',
      'https://claude.ai',
      'http://claude.ai/metadata.json',
      'https://claude.ai/metadata.json#x',
      'https://user@claude.ai/metadata.json',
      '0f9e3c2a-1b2c-4d5e-8f90-123456789abc',
    ]) {
      expect(isMetadataClientId(value), value).toBe(false);
    }
  });

  it('are fetched from public addresses only', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      'not an address',
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    for (const address of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111']) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });

  it('are never requested from a private address, by literal or by name', async () => {
    const fetchDocument = createClientMetadataFetcher();
    await expect(fetchDocument(new URL('https://127.0.0.1/metadata.json'))).rejects.toThrow(
      /public/,
    );
    await expect(fetchDocument(new URL('https://[::1]/metadata.json'))).rejects.toThrow(/public/);
    await expect(fetchDocument(new URL('https://localhost/metadata.json'))).rejects.toThrow(
      /public/,
    );
  });

  it('give a name with control characters removed and its length capped', () => {
    expect(cleanClientName('Claude\u0000 Code\n', 'x')).toBe('Claude Code');
    expect(cleanClientName('   ', 'fallback')).toBe('fallback');
    expect(cleanClientName('a'.repeat(300), 'x')).toHaveLength(100);
  });
});

describe('metadata', () => {
  const config = resolveOAuthConfig({
    apiUrl: 'https://shelf.example/',
    webUrl: 'https://shelf.example',
    fetchClientMetadata: () => Promise.reject(new Error('unused')),
  });

  it('names one issuer, without a trailing slash, as the server for /mcp', () => {
    expect(protectedResourceMetadata(config)).toMatchObject({
      resource: 'https://shelf.example/mcp',
      authorization_servers: ['https://shelf.example'],
      scopes_supported: ['prompts:read', 'prompts:write'],
    });
    expect(config.resourceMetadataUrl).toBe(
      'https://shelf.example/.well-known/oauth-protected-resource/mcp',
    );
  });

  it('advertises S256 only, public clients only, metadata documents, and iss', () => {
    expect(authorizationServerMetadata(config)).toMatchObject({
      issuer: 'https://shelf.example',
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  });

  it('compares resources ignoring one trailing slash', () => {
    expect(sameResource('https://shelf.example/mcp/', 'https://shelf.example/mcp')).toBe(true);
    expect(sameResource('https://shelf.example/mcp2', 'https://shelf.example/mcp')).toBe(false);
  });
});
