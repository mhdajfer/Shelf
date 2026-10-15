import {
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  type McpServer,
} from '@modelcontextprotocol/server';

import { MAX_PAGE_SIZE, promptRepo, type Database } from '@shelf/db';
import { idSchema } from '@shelf/shared';

import { toMarkdown } from '../http/markdown.js';
import type { McpGrant } from './auth.js';
import { decodeCursor, nextCursor } from './naming.js';

const SCHEME = 'shelf://prompts/';
const MIME_TYPE = 'text/markdown';

export const promptUri = (id: string): string => `${SCHEME}${id}`;

/**
 * Each prompt in the grant's set as a resource, so a client can attach it as
 * context instead of running it. Hand-written handlers rather than a
 * registered template, so the list pages through a large shelf the same way
 * prompts/list does.
 */
export function registerResources(server: McpServer, db: Database, grant: McpGrant): void {
  server.server.registerCapabilities({ resources: {} });

  server.server.setRequestHandler('resources/list', async (request) => {
    const after = decodeCursor(request.params?.cursor);
    if (after === null) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'That cursor is not valid.');
    }

    const page = await promptRepo.listInSet(db, grant.scope, {
      limit: MAX_PAGE_SIZE,
      ...(after === undefined ? {} : { after }),
    });
    const cursor = nextCursor(page, MAX_PAGE_SIZE);
    return {
      resources: page.map((prompt) => ({
        uri: promptUri(prompt.id),
        name: prompt.commandName ?? prompt.id,
        title: prompt.title,
        mimeType: MIME_TYPE,
        ...(prompt.description === null ? {} : { description: prompt.description }),
      })),
      ...(cursor === undefined ? {} : { nextCursor: cursor }),
    };
  });

  server.server.setRequestHandler('resources/templates/list', () => ({
    resourceTemplates: [
      {
        uriTemplate: `${SCHEME}{id}`,
        name: 'prompt',
        title: 'A prompt on your shelf',
        description: 'One of your prompts as Markdown: its metadata and current body.',
        mimeType: MIME_TYPE,
      },
    ],
  }));

  server.server.setRequestHandler('resources/read', async (request) => {
    const { uri } = request.params;
    const id = uri.startsWith(SCHEME) ? idSchema.safeParse(uri.slice(SCHEME.length)) : null;
    const prompt =
      id?.success === true ? await promptRepo.findInSet(db, grant.scope, { id: id.data }) : null;
    // A malformed URI, an unknown id, and a prompt outside the set read alike.
    if (prompt === null) throw new ResourceNotFoundError(uri);

    return { contents: [{ uri, mimeType: MIME_TYPE, text: toMarkdown(prompt) }] };
  });
}
