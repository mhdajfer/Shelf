import type { PromptArgument } from '@modelcontextprotocol/server';

import type { PromptSummary } from '@shelf/db';
import { commandNameSchema, type TemplateValues, type TemplateVariable } from '@shelf/shared';

import { env } from '../config/env.js';

/**
 * A prompt's variables as MCP prompt arguments, in order of first appearance.
 * Order matters: Claude Code passes slash-command arguments positionally.
 */
export function argumentsFor(variables: TemplateVariable[]): PromptArgument[] {
  return variables.map((variable) =>
    variable.defaultValue === undefined
      ? { name: variable.name, required: true }
      : {
          name: variable.name,
          required: false,
          description:
            variable.defaultValue === ''
              ? 'Optional. Empty by default.'
              : `Optional. Default: ${variable.defaultValue}`,
        },
  );
}

/**
 * Argument values from a client. An empty string counts as not supplied:
 * clients send one for an argument the user skipped, and the variable's
 * default should apply rather than be erased.
 */
export function suppliedValues(args: Record<string, string> | undefined): TemplateValues {
  return Object.fromEntries(Object.entries(args ?? {}).filter(([, value]) => value !== ''));
}

/** The prompt's page in the web app. */
export const promptUrl = (id: string): string => `${env.PUBLIC_WEB_URL}/p/${id}`;

/**
 * `prompts/list` and `resources/list` page by the last command name returned.
 * The cursor is opaque to clients; base64url keeps it that way.
 */
export function encodeCursor(lastName: string): string {
  return Buffer.from(lastName, 'utf8').toString('base64url');
}

/** Null for a cursor this server could not have issued. */
export function decodeCursor(cursor: string | undefined): string | null | undefined {
  if (cursor === undefined) return undefined;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const parsed = commandNameSchema.safeParse(decoded);
  return parsed.success && parsed.data === decoded ? decoded : null;
}

/** The next cursor when the page came back full, so there may be more. */
export function nextCursor(page: PromptSummary[], pageSize: number): string | undefined {
  const last = page.at(-1);
  return page.length === pageSize && last?.commandName != null
    ? encodeCursor(last.commandName)
    : undefined;
}
