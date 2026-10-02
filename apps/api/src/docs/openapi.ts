import { z } from 'zod';
import { createDocument } from 'zod-openapi';

import {
  changePasswordSchema,
  collectionOrderSchema,
  collectionSchema,
  createPromptSchema,
  deleteAccountSchema,
  forgotPasswordSchema,
  forkPromptSchema,
  importEnvelopeSchema,
  loginSchema,
  publicListQuerySchema,
  reportPromptSchema,
  resetPasswordSchema,
  resolveReportSchema,
  runSchema,
  shelfListQuerySchema,
  signupSchema,
  toolSchema,
  updateProfileSchema,
  updatePromptSchema,
  verifyEmailSchema,
} from '@shelf/shared';

import { ERROR_CODES } from '../http/errors.js';

const errorSchema = z
  .object({
    error: z.object({
      code: z.enum(Object.keys(ERROR_CODES) as [string, ...string[]]),
      message: z.string().meta({ description: 'A sentence that is safe to show to the user.' }),
      details: z
        .array(z.object({ field: z.string(), message: z.string() }))
        .optional()
        .meta({ description: 'Present for validation failures, one entry per field.' }),
    }),
  })
  .meta({ id: 'Error' });

const ERROR_TEXT: Record<number, string> = {
  400: 'The request was not valid. `details` names the fields.',
  401: 'Sign in to continue.',
  402: "The actor has used today's credits.",
  403: 'Readable, but not yours to change; or the CSRF token is missing.',
  404: 'Does not exist, or is not readable by this actor. The two are indistinguishable.',
  409: 'Conflicts with existing data, such as a taken handle.',
  429: 'A rate limit was reached.',
  503: 'An upstream service (the model, or the bot check) is unavailable.',
};

const failures = (...statuses: number[]) =>
  Object.fromEntries(
    statuses.map((status) => [
      String(status),
      {
        description: ERROR_TEXT[status] ?? 'Error',
        content: { 'application/json': { schema: errorSchema } },
      },
    ]),
  );

const body = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });
const ok = (description: string, status = '200') => ({ [status]: { description } });

const id = z.uuid().meta({ description: 'A prompt id.' });
const promptPath = z.object({ id });
const versionPath = z.object({ id, versionId: z.uuid() });
const collectionPath = z.object({ id: z.uuid().meta({ description: 'A collection id.' }) });
const collectionItemPath = z.object({ id: z.uuid(), promptId: z.uuid() });

const WRITE = 'Requires the `x-csrf-token` header, as every state-changing request does.';

/**
 * The API described for people and tools that are not the web app. Request
 * bodies and query strings are generated from the same Zod schemas the routes
 * validate with, so they cannot drift from what is accepted. `openapi.test.ts`
 * fails if a route is added without an entry here.
 */
export function buildOpenApiDocument(serverUrl: string): ReturnType<typeof createDocument> {
  return createDocument(
    {
      openapi: '3.1.0',
      info: {
        title: 'Shelf API',
        version: '1.0.0',
        description: [
          'A library for prompts you reuse.',
          '',
          '**Identity.** A signed-in user is identified by the `shelf_session` cookie; a guest by a',
          'signed `shelf_guest` cookie issued the first time they do something that needs one.',
          '',
          '**CSRF.** `GET /auth/me` returns a `csrfToken` and sets the `shelf_csrf` cookie. Every',
          'request that is not GET or HEAD must send the same value in `x-csrf-token`.',
          '',
          '**Privacy.** A prompt the caller cannot read answers `404`, identically to one that does',
          'not exist. `403` is only ever returned for something the caller can already see.',
        ].join('\n'),
      },
      servers: [{ url: `${serverUrl}/api/v1` }],
      tags: [
        { name: 'Library', description: 'The public shelf. No account needed.' },
        { name: 'Prompts', description: 'Create, read, change, and version prompts.' },
        { name: 'Shelf', description: "The signed-in user's own prompts and collections." },
        { name: 'Runs', description: 'Model-backed test runs and editor tools.' },
        { name: 'Auth', description: 'Accounts and sessions.' },
        { name: 'Admin', description: 'Moderation. 404 for anyone who is not an admin.' },
        { name: 'System', description: 'Health and scheduled work.' },
      ],
      paths: {
        '/health': {
          get: {
            tags: ['System'],
            summary: 'Report whether the database and Redis answer',
            responses: { ...ok('Both datastores answer.'), '503': { description: 'One is down.' } },
          },
        },
        '/cron/trending': {
          post: {
            tags: ['System'],
            summary: 'Recompute trending scores',
            description: 'Authenticated with `Authorization: Bearer $CRON_SECRET`, not a session.',
            responses: { ...ok('Rescored.'), ...failures(401) },
          },
        },

        '/prompts': {
          get: {
            tags: ['Library'],
            summary: 'List or search public prompts',
            requestParams: { query: publicListQuerySchema },
            responses: { ...ok('A page of prompts with a total.'), ...failures(400, 429) },
          },
          post: {
            tags: ['Prompts'],
            summary: 'Create a prompt',
            description: `Private by default for a user. A guest posts publicly and spends one create credit. ${WRITE}`,
            requestBody: body(createPromptSchema),
            responses: { ...ok('Created.', '201'), ...failures(400, 401, 402, 403, 409, 429) },
          },
        },
        '/categories': {
          get: {
            tags: ['Library'],
            summary: 'Count public prompts per category',
            responses: ok('Categories with counts.'),
          },
        },
        '/tags': {
          get: {
            tags: ['Library'],
            summary: 'The most used tags on the public shelf',
            responses: ok('Tags with counts.'),
          },
        },
        '/users/{handle}': {
          get: {
            tags: ['Library'],
            summary: 'A public profile',
            requestParams: { path: z.object({ handle: z.string() }) },
            responses: { ...ok('Handle, name, join date, public prompt count.'), ...failures(404) },
          },
        },
        '/sitemap': {
          get: {
            tags: ['Library'],
            summary: 'Ids of every public, active prompt',
            responses: ok('Entries with update times.'),
          },
        },

        '/prompts/{id}': {
          get: {
            tags: ['Prompts'],
            summary: 'Read a prompt',
            requestParams: { path: promptPath },
            responses: { ...ok('The prompt, with what it is to the caller.'), ...failures(404) },
          },
          patch: {
            tags: ['Prompts'],
            summary: 'Change a prompt',
            description: `A changed \`body\` is saved as a new version. ${WRITE}`,
            requestParams: { path: promptPath },
            requestBody: body(updatePromptSchema),
            responses: { ...ok('The updated prompt.'), ...failures(400, 401, 403, 404, 429) },
          },
          delete: {
            tags: ['Prompts'],
            summary: 'Delete a prompt',
            description: `A soft delete. ${WRITE}`,
            requestParams: { path: promptPath },
            responses: { ...ok('Deleted.', '204'), ...failures(403, 404) },
          },
        },
        '/prompts/{id}/versions': {
          get: {
            tags: ['Prompts'],
            summary: 'Version history, newest first',
            requestParams: { path: promptPath },
            responses: { ...ok('Versions.'), ...failures(404) },
          },
        },
        '/prompts/{id}/versions/{versionId}': {
          get: {
            tags: ['Prompts'],
            summary: 'One version',
            requestParams: { path: versionPath },
            responses: { ...ok('The version.'), ...failures(404) },
          },
        },
        '/prompts/{id}/versions/{versionId}/restore': {
          post: {
            tags: ['Prompts'],
            summary: 'Restore a version',
            description: `Appends the old body as a new version; nothing is rewound. ${WRITE}`,
            requestParams: { path: versionPath },
            responses: { ...ok('The updated prompt.'), ...failures(403, 404) },
          },
        },
        '/prompts/{id}/diff': {
          get: {
            tags: ['Prompts'],
            summary: 'Line diff between two versions',
            requestParams: {
              path: promptPath,
              query: z.object({
                from: z.string().optional().meta({ description: 'A version id or number.' }),
                to: z.string().optional().meta({ description: 'Defaults to the current version.' }),
              }),
            },
            responses: { ...ok('The changes.'), ...failures(404) },
          },
        },
        '/prompts/{id}/fork': {
          post: {
            tags: ['Prompts'],
            summary: 'Fork a prompt onto your shelf',
            description: WRITE,
            requestParams: { path: promptPath },
            requestBody: body(forkPromptSchema),
            responses: { ...ok('Your copy.', '201'), ...failures(401, 403, 404, 409) },
          },
        },
        '/prompts/{id}/forks': {
          get: {
            tags: ['Prompts'],
            summary: 'Public forks of a prompt',
            requestParams: { path: promptPath },
            responses: { ...ok('Forks.'), ...failures(404) },
          },
        },
        '/prompts/{id}/vote': {
          put: {
            tags: ['Prompts'],
            summary: 'Upvote',
            description: `Idempotent per voter. ${WRITE}`,
            requestParams: { path: promptPath },
            responses: { ...ok('The new count.'), ...failures(400, 404, 429) },
          },
          delete: {
            tags: ['Prompts'],
            summary: 'Remove your upvote',
            description: WRITE,
            requestParams: { path: promptPath },
            responses: { ...ok('The new count.'), ...failures(400, 404, 429) },
          },
        },
        '/prompts/{id}/report': {
          post: {
            tags: ['Prompts'],
            summary: 'Report a public prompt',
            description: `Three different reporters hide it pending review. ${WRITE}`,
            requestParams: { path: promptPath },
            requestBody: body(reportPromptSchema),
            responses: { ...ok('Recorded.', '201'), ...failures(400, 404, 429) },
          },
        },
        '/prompts/{id}/export': {
          get: {
            tags: ['Prompts'],
            summary: 'Download a prompt as Markdown',
            requestParams: { path: promptPath },
            responses: { ...ok('A Markdown file.'), ...failures(404) },
          },
        },
        '/prompts/{id}/runs': {
          get: {
            tags: ['Runs'],
            summary: 'Your own earlier runs of a prompt',
            requestParams: { path: promptPath },
            responses: { ...ok('Runs, newest first.'), ...failures(404) },
          },
        },
        '/prompts/{id}/collections': {
          get: {
            tags: ['Shelf'],
            summary: 'Which of your collections a prompt is in',
            requestParams: { path: promptPath },
            responses: { ...ok('Collection ids.'), ...failures(401) },
          },
        },

        '/shelf/prompts': {
          get: {
            tags: ['Shelf'],
            summary: 'Your prompts',
            requestParams: { query: shelfListQuerySchema },
            responses: { ...ok('A page of your prompts.'), ...failures(401) },
          },
        },
        '/shelf/summary': {
          get: {
            tags: ['Shelf'],
            summary: 'Sidebar counts and collections',
            responses: { ...ok('Counts and collections.'), ...failures(401) },
          },
        },
        '/collections': {
          post: {
            tags: ['Shelf'],
            summary: 'Create a collection',
            description: WRITE,
            requestBody: body(collectionSchema),
            responses: { ...ok('Created.', '201'), ...failures(400, 401, 409) },
          },
        },
        '/collections/order': {
          put: {
            tags: ['Shelf'],
            summary: 'Reorder collections',
            description: WRITE,
            requestBody: body(collectionOrderSchema),
            responses: { ...ok('Reordered.'), ...failures(400, 401) },
          },
        },
        '/collections/{id}': {
          patch: {
            tags: ['Shelf'],
            summary: 'Rename a collection',
            description: WRITE,
            requestParams: { path: collectionPath },
            requestBody: body(collectionSchema),
            responses: { ...ok('Renamed.'), ...failures(400, 401, 404, 409) },
          },
          delete: {
            tags: ['Shelf'],
            summary: 'Delete a collection',
            description: `The prompts in it stay on the shelf. ${WRITE}`,
            requestParams: { path: collectionPath },
            responses: { ...ok('Deleted.', '204'), ...failures(401, 404) },
          },
        },
        '/collections/{id}/prompts/{promptId}': {
          put: {
            tags: ['Shelf'],
            summary: 'File a prompt in a collection',
            description: `Only when you own both. ${WRITE}`,
            requestParams: { path: collectionItemPath },
            responses: { ...ok('Filed.'), ...failures(401, 404) },
          },
          delete: {
            tags: ['Shelf'],
            summary: 'Take a prompt out of a collection',
            description: WRITE,
            requestParams: { path: collectionItemPath },
            responses: { ...ok('Removed.', '204'), ...failures(401) },
          },
        },
        '/export': {
          get: {
            tags: ['Shelf'],
            summary: 'Export your whole shelf as JSON',
            responses: { ...ok('A `shelf-export` file.'), ...failures(401) },
          },
        },
        '/import': {
          post: {
            tags: ['Shelf'],
            summary: 'Import an export file',
            description: `Every imported prompt arrives private. Malformed entries are skipped and reported. ${WRITE}`,
            requestBody: body(importEnvelopeSchema),
            responses: {
              ...ok('How many were imported, and what was skipped.'),
              ...failures(400, 401),
            },
          },
        },

        '/credits': {
          get: {
            tags: ['Runs'],
            summary: "Today's remaining allowance",
            responses: ok('Create and model allowances.'),
          },
        },
        '/runs': {
          post: {
            tags: ['Runs'],
            summary: 'Run a prompt version against the model',
            description: [
              'Answers with `text/event-stream`. Events are `delta` (a piece of text), then `done`',
              '(the finished run and the new credit balance) or `error`. Every refusal happens',
              'before the stream opens and is an ordinary JSON error.',
              WRITE,
            ].join(' '),
            requestBody: body(runSchema),
            responses: { ...ok('An event stream.'), ...failures(400, 402, 404, 429, 503) },
          },
        },
        '/tools/tighten': {
          post: {
            tags: ['Runs'],
            summary: 'Propose a shorter rewrite of a prompt',
            description: `Reports any placeholder the rewrite lost. Costs one model credit. ${WRITE}`,
            requestBody: body(toolSchema),
            responses: { ...ok('The rewrite.'), ...failures(400, 402, 429, 503) },
          },
        },
        '/tools/suggest': {
          post: {
            tags: ['Runs'],
            summary: 'Suggest improvements to a prompt',
            description: `Costs one model credit. ${WRITE}`,
            requestBody: body(toolSchema),
            responses: { ...ok('Up to five suggestions.'), ...failures(400, 402, 429, 503) },
          },
        },

        '/auth/csrf': {
          get: { tags: ['Auth'], summary: 'Get a CSRF token', responses: ok('The token.') },
        },
        '/auth/me': {
          get: {
            tags: ['Auth'],
            summary: 'Who is asking, and what the deployment supports',
            responses: ok('The user or guest, a CSRF token, and feature flags.'),
          },
          patch: {
            tags: ['Auth'],
            summary: 'Change your name or handle',
            description: WRITE,
            requestBody: body(updateProfileSchema),
            responses: { ...ok('The updated user.'), ...failures(400, 401, 409) },
          },
        },
        '/auth/signup': {
          post: {
            tags: ['Auth'],
            summary: 'Create an account',
            description: `Signs the caller in and emails a verification link. ${WRITE}`,
            requestBody: body(signupSchema),
            responses: { ...ok('Created.', '201'), ...failures(400, 409, 429) },
          },
        },
        '/auth/login': {
          post: {
            tags: ['Auth'],
            summary: 'Sign in',
            description: WRITE,
            requestBody: body(loginSchema),
            responses: { ...ok('Signed in.'), ...failures(400, 401, 429) },
          },
        },
        '/auth/logout': {
          post: { tags: ['Auth'], summary: 'Sign out', description: WRITE, responses: ok('Done.') },
        },
        '/auth/verify-email': {
          post: {
            tags: ['Auth'],
            summary: 'Confirm an email address',
            description: WRITE,
            requestBody: body(verifyEmailSchema),
            responses: { ...ok('Verified.'), ...failures(400) },
          },
        },
        '/auth/resend-verification': {
          post: {
            tags: ['Auth'],
            summary: 'Send the verification email again',
            description: WRITE,
            responses: { ...ok('Sent, if it was needed.'), ...failures(401, 429) },
          },
        },
        '/auth/forgot-password': {
          post: {
            tags: ['Auth'],
            summary: 'Request a password reset link',
            description: `Answers the same whether or not the address is registered. ${WRITE}`,
            requestBody: body(forgotPasswordSchema),
            responses: { ...ok('Accepted.'), ...failures(400, 429) },
          },
        },
        '/auth/reset-password': {
          post: {
            tags: ['Auth'],
            summary: 'Set a new password from a reset link',
            description: `Signs out every session. ${WRITE}`,
            requestBody: body(resetPasswordSchema),
            responses: { ...ok('Changed.'), ...failures(400, 429) },
          },
        },
        '/auth/change-password': {
          post: {
            tags: ['Auth'],
            summary: 'Change your password',
            description: WRITE,
            requestBody: body(changePasswordSchema),
            responses: { ...ok('Changed.'), ...failures(400, 401, 429) },
          },
        },
        '/auth/delete-account': {
          post: {
            tags: ['Auth'],
            summary: 'Delete your account and everything it owns',
            description: WRITE,
            requestBody: body(deleteAccountSchema),
            responses: { ...ok('Deleted.'), ...failures(400, 401, 429) },
          },
        },
        '/auth/oauth/google': {
          get: {
            tags: ['Auth'],
            summary: 'Start Google sign-in',
            responses: { '302': { description: 'Redirects to Google.' }, ...failures(503) },
          },
        },
        '/auth/oauth/google/callback': {
          get: {
            tags: ['Auth'],
            summary: 'Finish Google sign-in',
            responses: { '302': { description: 'Redirects to the web app.' } },
          },
        },

        '/admin/overview': {
          get: {
            tags: ['Admin'],
            summary: 'Headline counts',
            responses: { ...ok('Counts.'), ...failures(404) },
          },
        },
        '/admin/reports': {
          get: {
            tags: ['Admin'],
            summary: 'Public prompts with open reports',
            responses: { ...ok('The moderation queue.'), ...failures(404) },
          },
        },
        '/admin/reports/{promptId}/resolve': {
          post: {
            tags: ['Admin'],
            summary: 'Restore or remove a reported prompt',
            description: WRITE,
            requestParams: { path: z.object({ promptId: z.uuid() }) },
            requestBody: body(resolveReportSchema),
            responses: { ...ok('Resolved.'), ...failures(400, 404) },
          },
        },
      },
    },
    // The import envelope validates its entries one by one in the route, so
    // their schema is deliberately open here.
    { allowEmptySchema: { unknown: true } },
  );
}
