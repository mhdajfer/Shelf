import { ProtocolError, ProtocolErrorCode, type McpServer } from '@modelcontextprotocol/server';

import { MAX_PAGE_SIZE, promptRepo, type Database } from '@shelf/db';
import { missingVariables, parseTemplate, renderParsed } from '@shelf/shared';

import type { McpGrant } from './auth.js';
import { argumentsFor, decodeCursor, nextCursor, suppliedValues } from './naming.js';

const invalidParams = (message: string): ProtocolError =>
  new ProtocolError(ProtocolErrorCode.InvalidParams, message);

/** One message for an unknown name and a prompt outside the grant's set, so the two cannot be told apart. */
const unknownPrompt = (name: string): ProtocolError =>
  invalidParams(`There is no prompt named "${name}" on this shelf.`);

/**
 * The user's prompts as MCP prompts. These are request handlers rather than
 * one registerPrompt per prompt: the prompts are data, and registering them
 * all would load the whole set on every request, tool calls included.
 */
export function registerPrompts(server: McpServer, db: Database, grant: McpGrant): void {
  server.server.registerCapabilities({ prompts: {}, completions: {} });

  server.server.setRequestHandler('prompts/list', async (request) => {
    const after = decodeCursor(request.params?.cursor);
    if (after === null) throw invalidParams('That cursor is not valid.');

    const page = await promptRepo.listInSet(db, grant.scope, {
      limit: MAX_PAGE_SIZE,
      ...(after === undefined ? {} : { after }),
    });
    const cursor = nextCursor(page, MAX_PAGE_SIZE);
    return {
      prompts: page.map((prompt) => ({
        name: prompt.commandName ?? '',
        title: prompt.title,
        ...(prompt.description === null ? {} : { description: prompt.description }),
        arguments: argumentsFor(prompt.variables),
      })),
      ...(cursor === undefined ? {} : { nextCursor: cursor }),
    };
  });

  server.server.setRequestHandler('prompts/get', async (request) => {
    const { name } = request.params;
    const prompt = await promptRepo.findInSet(db, grant.scope, { commandName: name });
    if (prompt === null) throw unknownPrompt(name);

    // Rendered from the body exactly as the web preview renders it.
    const parsed = parseTemplate(prompt.body);
    const values = suppliedValues(request.params.arguments);
    const missing = missingVariables(parsed, values);
    if (missing.length > 0) {
      throw invalidParams(
        `"${name}" needs a value for ${missing.map((variable) => `"${variable}"`).join(', ')}.`,
      );
    }

    return {
      ...(prompt.description === null ? {} : { description: prompt.description }),
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: renderParsed(parsed, values, { onMissing: 'empty' }),
          },
        },
      ],
    };
  });

  /** Offers a variable's default, so a client's argument field starts filled in. */
  server.server.setRequestHandler('completion/complete', async (request) => {
    const empty = { completion: { values: [], hasMore: false } };
    const { ref, argument } = request.params;
    if (ref.type !== 'ref/prompt') return empty;

    const prompt = await promptRepo.findInSet(db, grant.scope, { commandName: ref.name });
    const fallback = prompt?.variables.find(
      (variable) => variable.name === argument.name,
    )?.defaultValue;
    if (fallback === undefined || fallback === '' || !fallback.startsWith(argument.value)) {
      return empty;
    }
    return { completion: { values: [fallback], total: 1, hasMore: false } };
  });
}
