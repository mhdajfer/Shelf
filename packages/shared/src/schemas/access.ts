import { z } from 'zod';

import { LIMITS } from '../constants.js';

/** What an access grant may do over MCP. Write always comes with read. */
export const ACCESS_SCOPES = ['prompts:read', 'prompts:write'] as const;
export type AccessScope = (typeof ACCESS_SCOPES)[number];

/** Which of the user's own prompts a grant can see. */
export const PROMPT_SETS = ['all', 'pinned', 'collection'] as const;
export type PromptSet = (typeof PROMPT_SETS)[number];

/** Lifetimes offered for a personal access token. There is no "never". */
export const ACCESS_TOKEN_LIFETIMES_DAYS = [30, 90, 365] as const;
export const DEFAULT_ACCESS_TOKEN_LIFETIME_DAYS = 90;

export const createAccessTokenSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Name the token after where it will be used.')
      .max(
        LIMITS.accessTokenNameMax,
        `Token names are limited to ${String(LIMITS.accessTokenNameMax)} characters.`,
      ),
    /** Read is implied; this only says whether the token may also save prompts. */
    write: z.boolean().default(false),
    promptSet: z.enum(PROMPT_SETS).default('all'),
    collectionId: z.uuid().optional(),
    expiresInDays: z
      .union(ACCESS_TOKEN_LIFETIMES_DAYS.map((days) => z.literal(days)))
      .default(DEFAULT_ACCESS_TOKEN_LIFETIME_DAYS),
  })
  .refine((input) => (input.promptSet === 'collection') === (input.collectionId !== undefined), {
    message: 'Choose a collection, or limit the token to all or pinned prompts.',
    path: ['collectionId'],
  });
export type CreateAccessTokenInput = z.input<typeof createAccessTokenSchema>;

/** A personal access token as Settings lists it. The secret is never part of it. */
export interface AccessTokenDto {
  id: string;
  name: string;
  scopes: AccessScope[];
  promptSet: PromptSet;
  collection: { id: string; name: string } | null;
  /** The token's prefix and first characters, enough to recognise it. */
  display: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
}

/** The answer to creating a token: the only response that ever carries the secret. */
export interface CreatedAccessTokenDto {
  token: AccessTokenDto;
  secret: string;
}

/**
 * What the consent page shows about an MCP client asking for access. Everything
 * about the client is its own claim; only `publishedBy` has been checked, by
 * fetching the client's metadata document from that host over HTTPS.
 */
export interface OAuthRequestDto {
  id: string;
  client: {
    name: string;
    /** The host serving the client's metadata document; null for a client registered here. */
    publishedBy: string | null;
  };
  /**
   * Where approving sends the browser: an app on this computer (a loopback
   * address), a website, or an app that registered its own URL scheme.
   */
  redirect: { kind: 'loopback' | 'web' | 'app'; target: string };
  /** What the client asked for. The user may approve less. */
  scopes: AccessScope[];
  /** The user's settings for this client from an earlier approval, if any. */
  current: { scopes: AccessScope[]; promptSet: PromptSet; collectionId: string | null } | null;
  expiresAt: string;
}

export const oauthDecisionSchema = z
  .object({
    approve: z.boolean(),
    /** Grant `prompts:write` too. Only honoured if the client asked for it. */
    write: z.boolean().default(false),
    promptSet: z.enum(PROMPT_SETS).default('all'),
    collectionId: z.uuid().optional(),
  })
  .refine(
    (input) =>
      !input.approve || (input.promptSet === 'collection') === (input.collectionId !== undefined),
    {
      message: 'Choose a collection, or allow all or pinned prompts.',
      path: ['collectionId'],
    },
  );
export type OAuthDecisionInput = z.input<typeof oauthDecisionSchema>;

/** Where the consent page sends the browser next: back to the client. */
export interface OAuthDecisionDto {
  redirectTo: string;
}

/** An app the user connected over OAuth, as Settings lists it. */
export interface ConnectedAppDto {
  id: string;
  name: string;
  publishedBy: string | null;
  scopes: AccessScope[];
  promptSet: PromptSet;
  collection: { id: string; name: string } | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
}
