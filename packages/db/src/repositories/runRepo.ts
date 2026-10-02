import { and, desc, eq } from 'drizzle-orm';

import type { ActorType } from '@shelf/shared';

import type { Database } from '../client.js';
import { runs } from '../schema/activity.js';
import { promptVersions } from '../schema/prompts.js';

export type RunStatus = 'ok' | 'error' | 'timeout';

export interface RunRecord {
  id: string;
  promptVersionId: string;
  versionNumber: number;
  inputs: Record<string, string>;
  output: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number | null;
  status: RunStatus;
  errorCode: string | null;
  createdAt: Date;
}

export interface RecordRunInput {
  promptVersionId: string;
  actorType: ActorType;
  actorId: string;
  inputs: Record<string, string>;
  output: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number;
  status: RunStatus;
  errorCode?: string | null;
}

/** Written once, when the run ends. Failed runs are kept: they explain a refund. */
async function record(db: Database, input: RecordRunInput): Promise<string> {
  const [row] = await db
    .insert(runs)
    .values({ ...input, errorCode: input.errorCode ?? null })
    .returning({ id: runs.id });
  if (row === undefined) throw new Error('run insert returned no row');
  return row.id;
}

/**
 * One actor's own runs of one prompt, newest first. A run holds whatever the
 * actor typed into the variables, so it is never shown to anyone else, not even
 * the prompt's owner. The caller has already established the prompt is readable.
 */
async function listForActor(
  db: Database,
  actor: { type: ActorType; id: string },
  promptId: string,
  limit = 20,
): Promise<RunRecord[]> {
  return db
    .select({
      id: runs.id,
      promptVersionId: runs.promptVersionId,
      versionNumber: promptVersions.number,
      inputs: runs.inputs,
      output: runs.output,
      tokensIn: runs.tokensIn,
      tokensOut: runs.tokensOut,
      latencyMs: runs.latencyMs,
      status: runs.status,
      errorCode: runs.errorCode,
      createdAt: runs.createdAt,
    })
    .from(runs)
    .innerJoin(promptVersions, eq(promptVersions.id, runs.promptVersionId))
    .where(
      and(
        eq(promptVersions.promptId, promptId),
        eq(runs.actorType, actor.type),
        eq(runs.actorId, actor.id),
      ),
    )
    .orderBy(desc(runs.createdAt))
    .limit(Math.min(Math.max(limit, 1), 50));
}

export const runRepo = { record, listForActor };
