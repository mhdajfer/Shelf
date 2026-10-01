import { LIMITS } from '../constants.js';
import type {
  ParsedTemplate,
  TemplateDiagnostic,
  TemplateToken,
  TemplateVariable,
} from './types.js';

/**
 * Grammar
 *
 *   variable  := "{{" name [ ":" default ] "}}"
 *   name      := [A-Za-z_][A-Za-z0-9_-]*          case sensitive, <= 64 chars
 *   default   := any text up to the first "}}"     surrounding whitespace trimmed
 *   escape    := "\{{" -> "{{" | "\}}" -> "}}" | "\\" -> "\"
 *
 * Only the first ":" splits name from default, so `{{url:https://x:8080}}`
 * defaults to `https://x:8080`.
 *
 * Anything that opens with "{{" but does not parse is left in the output
 * verbatim and reported as a diagnostic. The parser never throws and never
 * drops input: concatenating the source slices of every token reproduces the
 * input exactly.
 */

const OPEN = '{{';
const CLOSE = '}}';
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export interface ParseOptions {
  maxVariables?: number;
}

type TagResult =
  | { ok: true; name: string; defaultValue: string | undefined }
  | { ok: false; diagnostic: TemplateDiagnostic };

function parseTag(raw: string, start: number, end: number): TagResult {
  const colon = raw.indexOf(':');
  const name = (colon === -1 ? raw : raw.slice(0, colon)).trim();

  if (name.length === 0) {
    return {
      ok: false,
      diagnostic: {
        code: 'empty-name',
        message: 'This placeholder has no variable name.',
        start,
        end,
      },
    };
  }

  if (name.length > LIMITS.maxVariableNameLength) {
    return {
      ok: false,
      diagnostic: {
        code: 'invalid-name',
        message: `Variable names are limited to ${String(LIMITS.maxVariableNameLength)} characters.`,
        start,
        end,
      },
    };
  }

  if (!NAME_PATTERN.test(name)) {
    return {
      ok: false,
      diagnostic: {
        code: 'invalid-name',
        message: `"${name}" is not a valid variable name. Use letters, numbers, underscores, and hyphens, starting with a letter or underscore.`,
        start,
        end,
      },
    };
  }

  return { ok: true, name, defaultValue: colon === -1 ? undefined : raw.slice(colon + 1).trim() };
}

export function parseTemplate(source: string, options: ParseOptions = {}): ParsedTemplate {
  const maxVariables = options.maxVariables ?? LIMITS.maxVariablesPerPrompt;
  const tokens: TemplateToken[] = [];
  const diagnostics: TemplateDiagnostic[] = [];
  const byName = new Map<string, TemplateVariable>();

  let pending = '';
  let pendingStart = 0;
  let reportedOverflow = false;
  let i = 0;

  const appendText = (value: string, start: number): void => {
    if (pending.length === 0) pendingStart = start;
    pending += value;
  };

  const flushText = (end: number): void => {
    if (pending.length === 0) return;
    tokens.push({ kind: 'text', start: pendingStart, end, value: pending });
    pending = '';
  };

  while (i < source.length) {
    if (source[i] === '\\') {
      const pair = source.slice(i + 1, i + 3);
      if (pair === OPEN || pair === CLOSE) {
        appendText(pair, i);
        i += 3;
        continue;
      }
      if (source[i + 1] === '\\') {
        appendText('\\', i);
        i += 2;
        continue;
      }
      appendText('\\', i);
      i += 1;
      continue;
    }

    if (!source.startsWith(OPEN, i)) {
      appendText(source[i] as string, i);
      i += 1;
      continue;
    }

    const closeAt = source.indexOf(CLOSE, i + OPEN.length);
    if (closeAt === -1) {
      diagnostics.push({
        code: 'unclosed-tag',
        message: 'This placeholder is missing its closing }}.',
        start: i,
        end: source.length,
      });
      appendText(source.slice(i), i);
      i = source.length;
      break;
    }

    const end = closeAt + CLOSE.length;
    const raw = source.slice(i, end);
    const tag = parseTag(source.slice(i + OPEN.length, closeAt), i, end);

    if (!tag.ok) {
      diagnostics.push(tag.diagnostic);
      appendText(raw, i);
      i = end;
      continue;
    }

    flushText(i);
    tokens.push({
      kind: 'variable',
      start: i,
      end,
      name: tag.name,
      defaultValue: tag.defaultValue,
      raw,
    });

    const existing = byName.get(tag.name);
    if (existing === undefined) {
      byName.set(tag.name, {
        name: tag.name,
        defaultValue: tag.defaultValue,
        occurrences: 1,
        firstIndex: i,
      });
      if (byName.size > maxVariables && !reportedOverflow) {
        reportedOverflow = true;
        diagnostics.push({
          code: 'too-many-variables',
          message: `A prompt can use at most ${String(maxVariables)} different variables.`,
          start: i,
          end,
        });
      }
    } else {
      existing.occurrences += 1;
      if (tag.defaultValue !== undefined) {
        if (existing.defaultValue === undefined) {
          existing.defaultValue = tag.defaultValue;
        } else if (existing.defaultValue !== tag.defaultValue) {
          diagnostics.push({
            code: 'conflicting-default',
            message: `"${tag.name}" already has the default "${existing.defaultValue}". The first default is used.`,
            start: i,
            end,
          });
        }
      }
    }

    i = end;
  }

  flushText(i);

  return { tokens, variables: [...byName.values()], diagnostics };
}

/** Convenience wrapper for callers that only need the variable list. */
export function extractVariables(source: string, options?: ParseOptions): TemplateVariable[] {
  return parseTemplate(source, options).variables;
}
