import { z } from 'zod';

import { LIMITS } from '../constants.js';
import type { CreditsDto } from './prompt.js';

/** One variable's value. Generous, because inputs are often pasted documents. */
export const INPUT_VALUE_MAX = 20_000;
/** Ceiling on the fully rendered prompt sent to the model. */
export const RENDERED_PROMPT_MAX = 60_000;

export const runSchema = z.object({
  promptId: z.uuid(),
  /** Defaults to the prompt's current version. */
  versionId: z.uuid().optional(),
  inputs: z
    .record(
      z.string().max(LIMITS.maxVariableNameLength),
      z.string().max(INPUT_VALUE_MAX, 'That value is too long.'),
    )
    .default({})
    .refine(
      (inputs) => Object.keys(inputs).length <= LIMITS.maxVariablesPerPrompt,
      'Too many inputs.',
    ),
});
export type RunInput = z.input<typeof runSchema>;

export const toolSchema = z.object({
  body: z
    .string()
    .max(LIMITS.bodyMax, `Prompts are limited to ${String(LIMITS.bodyMax)} characters.`)
    .refine((value) => value.trim().length > 0, 'Write a prompt first.'),
});
export type ToolInput = z.infer<typeof toolSchema>;

export interface RunDto {
  id: string;
  versionId: string;
  versionNumber: number;
  inputs: Record<string, string>;
  output: string | null;
  status: 'ok' | 'error' | 'timeout';
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number | null;
  createdAt: string;
}

/** The events of `POST /runs`, sent as server-sent events named by `type`. */
export type RunStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; run: RunDto; credits: CreditsDto; model: string }
  | { type: 'error'; code: string; message: string; credits: CreditsDto };

export interface TightenDto {
  body: string;
  /** Placeholders the rewrite lost. Shown as a warning before the author accepts it. */
  droppedVariables: string[];
  credits: CreditsDto;
}

export interface SuggestionDto {
  title: string;
  detail: string;
}

export interface SuggestDto {
  suggestions: SuggestionDto[];
  credits: CreditsDto;
}
