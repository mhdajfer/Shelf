import type { Request } from 'express';

import {
  promptRepo,
  type Actor,
  type Database,
  type PromptSummary,
  type PromptVersionRecord,
  type ViewerState,
} from '@shelf/db';
import {
  GUEST_EDIT_WINDOW_MS,
  idSchema,
  type PromptDetailDto,
  type PromptDto,
  type PromptVersionDto,
} from '@shelf/shared';

import { notFound } from './errors.js';

const NO_STATE: ViewerState = { isOwner: false, hasVoted: false };

/** A guest's prompt freezes after the edit window; a user's never does. */
export function withinEditWindow(prompt: PromptSummary): boolean {
  return (
    prompt.author.kind === 'user' || Date.now() - prompt.createdAt.getTime() <= GUEST_EDIT_WINDOW_MS
  );
}

export function toPromptDto(prompt: PromptSummary, state: ViewerState = NO_STATE): PromptDto {
  return {
    id: prompt.id,
    title: prompt.title,
    description: prompt.description,
    category: prompt.category,
    modelHint: prompt.modelHint,
    visibility: prompt.visibility,
    status: prompt.status,
    body: prompt.body,
    variables: prompt.variables,
    versionNumber: prompt.versionNumber,
    currentVersionId: prompt.currentVersionId,
    tags: prompt.tags,
    upvoteCount: prompt.upvoteCount,
    forkCount: prompt.forkCount,
    forkedFromId: prompt.forkedFromId,
    // Pinning is the owner's private bookmark; nobody else learns of it.
    pinned: state.isOwner && prompt.pinnedAt !== null,
    author: prompt.author,
    createdAt: prompt.createdAt.toISOString(),
    updatedAt: prompt.updatedAt.toISOString(),
    viewer: {
      isOwner: state.isOwner,
      canEdit: state.isOwner && withinEditWindow(prompt),
      hasVoted: state.hasVoted,
    },
  };
}

/** One extra query for the whole page, not one per card. */
export async function toPromptDtos(
  db: Database,
  actor: Actor,
  prompts: PromptSummary[],
): Promise<PromptDto[]> {
  const states = await promptRepo.viewerStates(
    db,
    actor,
    prompts.map((prompt) => prompt.id),
  );
  return prompts.map((prompt) => toPromptDto(prompt, states.get(prompt.id)));
}

export async function toPromptDetailDto(
  db: Database,
  actor: Actor,
  prompt: PromptSummary,
): Promise<PromptDetailDto> {
  const [dto] = await toPromptDtos(db, actor, [prompt]);
  if (dto === undefined) throw notFound();

  // Resolved through the same visibility filter: a fork of a prompt that has
  // since gone private simply shows no lineage.
  const source =
    prompt.forkedFromId === null
      ? null
      : await promptRepo.findVisible(db, actor, prompt.forkedFromId);

  const viewerForkId =
    actor.type === 'user' ? await promptRepo.findForkId(db, actor.userId, prompt.id) : null;

  return {
    ...dto,
    viewerForkId,
    forkedFrom:
      source === null ? null : { id: source.id, title: source.title, author: source.author },
  };
}

export function toVersionDto(version: PromptVersionRecord): PromptVersionDto {
  return {
    id: version.id,
    promptId: version.promptId,
    number: version.number,
    body: version.body,
    variables: version.variables,
    note: version.note,
    createdAt: version.createdAt.toISOString(),
  };
}

/**
 * A malformed id is answered exactly like an unknown one. Passing it to
 * Postgres would raise a uuid cast error and turn a typo into a 500.
 */
export function uuidParam(req: Request, name: string): string {
  const parsed = idSchema.safeParse(req.params[name]);
  if (!parsed.success) throw notFound();
  return parsed.data;
}
