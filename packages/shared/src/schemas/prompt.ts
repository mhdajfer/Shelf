import { z } from 'zod';

import {
  CATEGORIES,
  LIMITS,
  PUBLIC_SORTS,
  VISIBILITIES,
  type PromptStatus,
  type Visibility,
} from '../constants.js';
import { parseTemplate } from '../template/parse.js';
import type { TemplateVariable } from '../template/types.js';

const TAG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export const tagSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(
    z
      .string()
      .min(1, 'Tags cannot be empty.')
      .max(LIMITS.tagMax, `Tags are limited to ${String(LIMITS.tagMax)} characters.`)
      .regex(TAG_PATTERN, 'Tags use lowercase letters, numbers, and hyphens.'),
  );

const tagsSchema = z
  .array(tagSchema)
  .max(LIMITS.tagsMax, `Use at most ${String(LIMITS.tagsMax)} tags.`)
  .transform((tags) => [...new Set(tags)]);

const titleSchema = z
  .string()
  .trim()
  .min(1, 'Give the prompt a title.')
  .max(LIMITS.titleMax, `Titles are limited to ${String(LIMITS.titleMax)} characters.`);

/** Empty input means "no value", so the API stores null rather than ''. */
const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} is limited to ${String(max)} characters.`)
    .transform((value) => (value === '' ? null : value))
    .nullable();

const bodySchema = z
  .string()
  .min(1, 'The prompt body cannot be empty.')
  .max(LIMITS.bodyMax, `Prompts are limited to ${String(LIMITS.bodyMax)} characters.`)
  .refine((value) => value.trim().length > 0, 'The prompt body cannot be empty.')
  // Malformed placeholders are allowed and shown as warnings in the editor; only
  // the hard variable ceiling blocks a save.
  .refine(
    (value) =>
      !parseTemplate(value).diagnostics.some((issue) => issue.code === 'too-many-variables'),
    `A prompt can use at most ${String(LIMITS.maxVariablesPerPrompt)} different variables.`,
  );

const noteSchema = optionalText(LIMITS.versionNoteMax, 'The version note');

export const createPromptSchema = z.object({
  title: titleSchema,
  description: optionalText(LIMITS.descriptionMax, 'The description').optional(),
  category: z.enum(CATEGORIES, 'Choose a category.'),
  modelHint: optionalText(LIMITS.modelHintMax, 'The model hint').optional(),
  body: bodySchema,
  tags: tagsSchema.optional(),
  visibility: z.enum(VISIBILITIES).optional(),
  note: noteSchema.optional(),
  turnstileToken: z.string().max(4096).optional(),
});
export type CreatePromptInput = z.input<typeof createPromptSchema>;

export const updatePromptSchema = z.object({
  title: titleSchema.optional(),
  description: optionalText(LIMITS.descriptionMax, 'The description').optional(),
  category: z.enum(CATEGORIES).optional(),
  modelHint: optionalText(LIMITS.modelHintMax, 'The model hint').optional(),
  body: bodySchema.optional(),
  tags: tagsSchema.optional(),
  visibility: z.enum(VISIBILITIES).optional(),
  pinned: z.boolean().optional(),
  /** Stored with the new version when `body` changes; ignored otherwise. */
  note: noteSchema.optional(),
});
export type UpdatePromptInput = z.input<typeof updatePromptSchema>;

export const forkPromptSchema = z.object({
  visibility: z.enum(VISIBILITIES).optional(),
});

export const reportPromptSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(10, 'Say a little more about what is wrong (at least 10 characters).')
    .max(LIMITS.reportReasonMax, `Keep it under ${String(LIMITS.reportReasonMax)} characters.`),
});
export type ReportPromptInput = z.infer<typeof reportPromptSchema>;

const csvList = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) =>
    (value === undefined ? [] : Array.isArray(value) ? value : value.split(','))
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, LIMITS.tagsMax),
  );

export const PAGE_SIZE = 24;

const pageSchema = z.coerce.number().int().min(1).max(10_000).default(1);
const limitSchema = z.coerce.number().int().min(1).max(50).default(PAGE_SIZE);

export const publicListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  sort: z.enum(PUBLIC_SORTS).default('trending'),
  category: z.enum(CATEGORIES).optional(),
  tag: csvList,
  model: z.string().trim().max(LIMITS.modelHintMax).optional(),
  author: z.string().trim().max(LIMITS.handleMax).optional(),
  page: pageSchema,
  limit: limitSchema,
});
export type PublicListQuery = z.infer<typeof publicListQuerySchema>;

export const shelfListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  pinned: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
  collection: z.uuid().optional(),
  page: pageSchema,
  limit: limitSchema,
});

export const idSchema = z.uuid('Not found.');

export interface PromptAuthorDto {
  kind: 'user' | 'guest';
  handle: string;
  name: string | null;
}

/** A prompt as the API returns it. Dates are ISO strings. */
export interface PromptDto {
  id: string;
  title: string;
  description: string | null;
  category: string;
  modelHint: string | null;
  visibility: Visibility;
  status: PromptStatus;
  body: string;
  variables: TemplateVariable[];
  versionNumber: number;
  currentVersionId: string | null;
  tags: string[];
  upvoteCount: number;
  forkCount: number;
  forkedFromId: string | null;
  pinned: boolean;
  author: PromptAuthorDto;
  createdAt: string;
  updatedAt: string;
  /** What this prompt is to whoever asked. */
  viewer: {
    isOwner: boolean;
    canEdit: boolean;
    hasVoted: boolean;
  };
}

export interface PromptDetailDto extends PromptDto {
  /** Present only when the source still exists and the viewer may read it. */
  forkedFrom: { id: string; title: string; author: PromptAuthorDto } | null;
  /** The viewer's own live fork of this prompt, if they have one. */
  viewerForkId: string | null;
}

export interface PromptVersionDto {
  id: string;
  promptId: string;
  number: number;
  body: string;
  variables: TemplateVariable[];
  note: string | null;
  createdAt: string;
}

export interface PromptListDto {
  items: PromptDto[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

export interface DiffChange {
  value: string;
  added: boolean;
  removed: boolean;
}

export interface VersionDiffDto {
  from: { id: string; number: number };
  to: { id: string; number: number };
  changes: DiffChange[];
}

export interface CreditAllowance {
  limit: number;
  used: number;
  remaining: number;
}

export interface CreditsDto {
  /** Null for signed-in users, who are not metered on creation. */
  create: CreditAllowance | null;
  model: CreditAllowance;
}

export const collectionNameSchema = z
  .string()
  .trim()
  .min(1, 'Give the collection a name.')
  .max(
    LIMITS.collectionNameMax,
    `Collection names are limited to ${String(LIMITS.collectionNameMax)} characters.`,
  );

export const collectionSchema = z.object({ name: collectionNameSchema });
export const collectionOrderSchema = z.object({ ids: z.array(z.uuid()).max(200) });

export interface CollectionDto {
  id: string;
  name: string;
  position: number;
  itemCount: number;
}

export interface ShelfSummaryDto {
  counts: { total: number; pinned: number; public: number };
  collections: CollectionDto[];
}
