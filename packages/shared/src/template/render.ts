import { parseTemplate, type ParseOptions } from './parse.js';
import type { ParsedTemplate, TemplateValues } from './types.js';

/**
 * What to emit for a variable with neither a supplied value nor a default.
 * `keep` leaves `{{name}}` in place so the gap is visible in the preview;
 * `empty` drops it, which is what export and test runs want.
 */
export type MissingBehavior = 'keep' | 'empty';

export interface RenderOptions {
  onMissing?: MissingBehavior;
}

/**
 * Defaults are resolved per variable rather than per occurrence. `{{a}} {{a:x}}`
 * declares one variable whose default is "x", so both occurrences render "x".
 */
function defaultsByName(parsed: ParsedTemplate): Map<string, string | undefined> {
  return new Map(parsed.variables.map((v) => [v.name, v.defaultValue]));
}

export function renderParsed(
  parsed: ParsedTemplate,
  values: TemplateValues = {},
  options: RenderOptions = {},
): string {
  const onMissing = options.onMissing ?? 'keep';
  const defaults = defaultsByName(parsed);
  let out = '';

  for (const token of parsed.tokens) {
    if (token.kind === 'text') {
      out += token.value;
      continue;
    }
    // A supplied empty string is a real value and beats the default; only
    // `undefined` counts as unsupplied, so clearing a prefilled field clears it.
    const supplied = values[token.name];
    const value = supplied === undefined ? defaults.get(token.name) : supplied;

    if (value !== undefined) out += value;
    else if (onMissing === 'keep') out += token.raw;
  }

  return out;
}

export function renderTemplate(
  source: string,
  values: TemplateValues = {},
  options: RenderOptions & ParseOptions = {},
): string {
  return renderParsed(parseTemplate(source, options), values, options);
}

/** Variable names the "Use" panel still needs before the prompt is complete. */
export function missingVariables(parsed: ParsedTemplate, values: TemplateValues = {}): string[] {
  return parsed.variables
    .filter((v) => values[v.name] === undefined && v.defaultValue === undefined)
    .map((v) => v.name);
}

/** Prefill for the "Use" panel form: declared defaults, empty otherwise. */
export function initialValues(parsed: ParsedTemplate): Record<string, string> {
  return Object.fromEntries(parsed.variables.map((v) => [v.name, v.defaultValue ?? '']));
}
