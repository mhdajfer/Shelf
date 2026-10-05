import { z } from 'zod';

import { CATEGORIES, LIMITS, type Visibility } from '../constants.js';

export const EXPORT_FORMAT = 'shelf-export';
export const EXPORT_VERSION = 1;
/** Prompts accepted by one import request. */
export const IMPORT_MAX_PROMPTS = 200;
/** Versions kept per imported prompt; older history beyond this is dropped. */
export const IMPORT_MAX_VERSIONS = 100;

export interface ExportedVersion {
  number: number;
  body: string;
  note: string | null;
  createdAt: string;
}

export interface ExportedPrompt {
  title: string;
  description: string | null;
  category: string;
  modelHint: string | null;
  visibility: Visibility;
  pinned: boolean;
  tags: string[];
  collections: string[];
  versions: ExportedVersion[];
}

/** The file `GET /export` produces and `POST /import` accepts. */
export interface ShelfExport {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  prompts: ExportedPrompt[];
}

/**
 * The envelope only. Each prompt is validated on its own afterwards, so one
 * malformed entry is skipped and reported instead of failing the whole file.
 */
export const importEnvelopeSchema = z.object({
  format: z.literal(EXPORT_FORMAT, 'This is not a Shelf export file.'),
  version: z.literal(EXPORT_VERSION, 'This export was made by a newer version of Shelf.'),
  prompts: z
    .array(z.unknown())
    .min(1, 'The file contains no prompts.')
    .max(
      IMPORT_MAX_PROMPTS,
      `One import can hold ${String(IMPORT_MAX_PROMPTS)} prompts. Split the file and import it in parts.`,
    ),
});

const nullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value == null || value === '' ? null : value));

/**
 * Deliberately forgiving about metadata and strict about content: an unknown
 * category becomes "other" and an invalid tag is dropped, but a prompt with no
 * usable body is rejected.
 */
export const importPromptSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'Missing a title.')
    .max(LIMITS.titleMax, 'The title is too long.'),
  description: nullableText(LIMITS.descriptionMax),
  category: z.enum(CATEGORIES).catch('other'),
  modelHint: nullableText(LIMITS.modelHintMax),
  pinned: z.boolean().catch(false),
  tags: z
    .array(z.unknown())
    .catch([])
    .transform((tags) => [
      ...new Set(
        tags
          .filter((tag): tag is string => typeof tag === 'string')
          .map((tag) => tag.trim().toLowerCase())
          .filter((tag) => /^[a-z0-9][a-z0-9-]*$/.test(tag) && tag.length <= LIMITS.tagMax),
      ),
    ])
    .transform((tags) => tags.slice(0, LIMITS.tagsMax)),
  collections: z
    .array(z.unknown())
    .catch([])
    .transform((names) => [
      ...new Set(
        names
          .filter((name): name is string => typeof name === 'string')
          .map((name) => name.trim())
          .filter((name) => name !== '' && name.length <= LIMITS.collectionNameMax),
      ),
    ])
    .transform((names) => names.slice(0, 20)),
  versions: z
    .array(
      z.object({
        body: z
          .string()
          .max(LIMITS.bodyMax, 'A version is longer than the body limit.')
          .refine((value) => value.trim() !== '', 'A version has an empty body.'),
        note: nullableText(LIMITS.versionNoteMax),
      }),
    )
    .min(1, 'Has no versions.')
    // Keep the most recent history when there is more than fits.
    .transform((versions) => versions.slice(-IMPORT_MAX_VERSIONS)),
});
export type ImportPrompt = z.infer<typeof importPromptSchema>;

export interface ImportResultDto {
  imported: number;
  skipped: { index: number; title: string | null; reason: string }[];
}

export const resolveReportSchema = z.object({ action: z.enum(['restore', 'remove']) });

export interface ReportedPromptDto {
  promptId: string;
  title: string;
  status: string;
  authorHandle: string;
  openReports: number;
  reasons: string[];
  lastReportedAt: string;
}

export interface AdminOverviewDto {
  users: number;
  publicPrompts: number;
  privatePrompts: number;
  hiddenPrompts: number;
  openReports: number;
  modelCallsToday: number;
  modelDailyCap: number;
}

export const deleteAccountSchema = z.object({
  /** Required for accounts that have a password; Google-only accounts type their handle instead. */
  password: z.string().max(200).optional(),
  confirmHandle: z.string().max(LIMITS.handleMax).optional(),
});
