/** Every internal URL is built here, so a route can move without a search-and-replace. */
export const routes = {
  home: '/',
  prompt: (id: string) => `/p/${id}`,
  editPrompt: (id: string) => `/p/${id}/edit`,
  promptHistory: (id: string) => `/p/${id}/history`,
  newPrompt: '/new',
  shelf: '/shelf',
  settings: '/settings',
  admin: '/admin',
  profile: (handle: string) => `/u/${handle}`,
  signIn: (next?: string) =>
    next === undefined ? '/sign-in' : `/sign-in?next=${encodeURIComponent(next)}`,
  signUp: '/sign-up',
  forgotPassword: '/forgot-password',
  /** Where the API's OAuth authorize endpoint sends the browser. */
  oauthConsent: (requestId: string) => `/oauth/consent?request=${encodeURIComponent(requestId)}`,
  /** Setup instructions for each MCP client. */
  mcpDocs: '/docs/mcp',
} as const;

/** Where MCP clients connect. */
export const MCP_URL = process.env.NEXT_PUBLIC_MCP_URL ?? 'http://localhost:4000/mcp';

/** How Claude Code names an MCP prompt from server "shelf": the slash command a user types. */
export const mcpCommand = (commandName: string): string => `/mcp__shelf__${commandName}`;

/** Where a visitor lands after signing in, unless they were on their way somewhere. */
export const AFTER_SIGN_IN = '/shelf';

/**
 * Only same-site paths are honoured as a post-sign-in destination; anything
 * else would make the sign-in page an open redirect.
 */
export function safeNext(next: string | null | undefined): string {
  if (next == null || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) {
    return AFTER_SIGN_IN;
  }
  return next;
}
