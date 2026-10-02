import { and, desc, eq, isNull, type SQL, sql } from 'drizzle-orm';

import { REPORTS_TO_AUTOHIDE, type ActorType, type CreditKind } from '@shelf/shared';

import type { Database, Executor } from '../client.js';
import { creditLedger, reports, votes } from '../schema/activity.js';
import { prompts } from '../schema/prompts.js';
import { users } from '../schema/users.js';

/** Someone who can vote or report: a signed-in user or a cookie-identified guest. */
export type Participant = { type: 'user'; userId: string } | { type: 'guest'; guestId: string };

/**
 * Inserts the vote and bumps the denormalised counter in one transaction. The
 * partial unique indexes decide whether the vote is new, so a double click or
 * two racing requests still count once. Returns the resulting count.
 */
async function addVote(db: Database, promptId: string, voter: Participant): Promise<number> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(votes)
      .values({
        promptId,
        userId: voter.type === 'user' ? voter.userId : null,
        guestId: voter.type === 'guest' ? voter.guestId : null,
      })
      .onConflictDoNothing()
      .returning({ id: votes.id });

    if (inserted.length > 0) {
      await tx
        .update(prompts)
        .set({ upvoteCount: sql`${prompts.upvoteCount} + 1` })
        .where(eq(prompts.id, promptId));
    }
    return currentVoteCount(tx, promptId);
  });
}

async function removeVote(db: Database, promptId: string, voter: Participant): Promise<number> {
  return db.transaction(async (tx) => {
    const removed = await tx
      .delete(votes)
      .where(
        and(
          eq(votes.promptId, promptId),
          voter.type === 'user' ? eq(votes.userId, voter.userId) : eq(votes.guestId, voter.guestId),
        ),
      )
      .returning({ id: votes.id });

    if (removed.length > 0) {
      await tx
        .update(prompts)
        .set({ upvoteCount: sql`GREATEST(${prompts.upvoteCount} - 1, 0)` })
        .where(eq(prompts.id, promptId));
    }
    return currentVoteCount(tx, promptId);
  });
}

async function currentVoteCount(db: Executor, promptId: string): Promise<number> {
  const [row] = await db
    .select({ count: prompts.upvoteCount })
    .from(prompts)
    .where(eq(prompts.id, promptId));
  return row?.count ?? 0;
}

export interface ReportOutcome {
  /** False when this actor had already reported the prompt. */
  created: boolean;
  /** True when this report took the prompt over the auto-hide threshold. */
  hidden: boolean;
}

/**
 * Records the report and, at the threshold, hides the prompt pending review.
 * One report per actor is enforced by the partial unique indexes, so the
 * threshold always means that many different people.
 */
async function addReport(
  db: Database,
  promptId: string,
  reporter: Participant,
  reason: string,
): Promise<ReportOutcome> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(reports)
      .values({
        promptId,
        reporterUserId: reporter.type === 'user' ? reporter.userId : null,
        reporterGuestId: reporter.type === 'guest' ? reporter.guestId : null,
        reason,
      })
      .onConflictDoNothing()
      .returning({ id: reports.id });

    if (inserted.length === 0) return { created: false, hidden: false };

    const [open] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(reports)
      .where(and(eq(reports.promptId, promptId), isNull(reports.resolvedAt)));

    if ((open?.count ?? 0) < REPORTS_TO_AUTOHIDE) return { created: true, hidden: false };

    const hidden = await tx
      .update(prompts)
      .set({ status: 'hidden' })
      .where(and(eq(prompts.id, promptId), eq(prompts.status, 'active')))
      .returning({ id: prompts.id });
    return { created: true, hidden: hidden.length > 0 };
  });
}

export interface ReportedPrompt {
  promptId: string;
  title: string;
  status: string;
  authorHandle: string;
  openReports: number;
  reasons: string[];
  lastReportedAt: Date;
}

/** The moderation queue: one row per prompt with unresolved reports. */
async function listReported(db: Database, limit = 50): Promise<ReportedPrompt[]> {
  const rows = await db
    .select({
      promptId: prompts.id,
      title: prompts.title,
      status: prompts.status,
      authorHandle: sql<string>`coalesce(${users.handle}, ${prompts.guestHandle}, 'guest')`,
      openReports: sql<number>`count(${reports.id})::int`,
      reasons: sql<string[]>`array_agg(${reports.reason} ORDER BY ${reports.createdAt} DESC)`,
      lastReportedAt: sql<Date>`max(${reports.createdAt})`.mapWith(reports.createdAt),
    })
    .from(reports)
    .innerJoin(prompts, eq(prompts.id, reports.promptId))
    .leftJoin(users, eq(users.id, prompts.ownerId))
    .where(
      and(
        isNull(reports.resolvedAt),
        // Moderation covers public content only; a private prompt cannot be
        // reported, and this keeps one from ever surfacing here regardless.
        eq(prompts.visibility, 'public'),
        sql`${prompts.status} <> 'deleted'`,
      ),
    )
    .groupBy(prompts.id, users.handle)
    .orderBy(desc(sql`max(${reports.createdAt})`))
    .limit(Math.min(Math.max(limit, 1), 100));

  return rows;
}

/**
 * Closes every open report on a prompt. `restore` puts a hidden prompt back on
 * the public shelf; `remove` takes it down for good.
 */
async function resolveReports(
  db: Database,
  promptId: string,
  adminId: string,
  action: 'restore' | 'remove',
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: prompts.id })
      .from(prompts)
      .where(
        and(
          eq(prompts.id, promptId),
          eq(prompts.visibility, 'public'),
          sql`${prompts.status} <> 'deleted'`,
        ),
      );
    if (target === undefined) return false;

    await tx
      .update(reports)
      .set({ resolvedAt: new Date(), resolvedBy: adminId })
      .where(and(eq(reports.promptId, promptId), isNull(reports.resolvedAt)));

    await tx
      .update(prompts)
      .set({ status: action === 'restore' ? 'active' : 'deleted' })
      .where(eq(prompts.id, promptId));
    return true;
  });
}

/** Which daily allowance a ledger kind draws on. `run` and `tool` share one. */
export type CreditPool = 'create' | 'model';

const POOL_KINDS: Record<CreditPool, CreditKind[]> = {
  create: ['create'],
  model: ['run', 'tool'],
};

const kindList = (pool: CreditPool) =>
  sql.join(
    POOL_KINDS[pool].map((kind) => sql`${kind}`),
    sql`, `,
  );

/** Midnight UTC today, computed in the database so every instance agrees. */
const TODAY = sql`(date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;

export interface CreditActor {
  type: ActorType;
  id: string;
  /** Guests only: a second allowance keyed on the hashed address. */
  ipHash?: string | null;
}

/**
 * Credits spent today from one pool, net of refunds. A refund carries no kind
 * of its own, so it is attributed through the debit it reverses.
 */
async function usedBy(db: Executor, pool: CreditPool, match: SQL): Promise<number> {
  const result = await db.execute<{ used: number }>(sql`
    SELECT coalesce(-sum(l.amount), 0)::int AS used
    FROM credit_ledger l
    LEFT JOIN credit_ledger o ON o.id = l.ref_id
    WHERE ${match}
      AND l.created_at >= ${TODAY}
      AND (
        l.kind::text IN (${kindList(pool)})
        OR (l.kind = 'refund' AND o.kind::text IN (${kindList(pool)}))
      )
  `);
  return result.rows[0]?.used ?? 0;
}

/**
 * For a guest, whichever of the cookie allowance and the address allowance is
 * more used: clearing cookies does not reset the count, and neither does a
 * shared address hand a second visitor a spent one for free on a new cookie.
 */
async function used(db: Executor, actor: CreditActor, pool: CreditPool): Promise<number> {
  const byActor = await usedBy(
    db,
    pool,
    sql`l.actor_type = ${actor.type} AND l.actor_id = ${actor.id}`,
  );
  if (actor.type !== 'guest' || actor.ipHash == null) return byActor;

  const byAddress = await usedBy(
    db,
    pool,
    sql`l.actor_type = 'guest' AND l.ip_hash = ${actor.ipHash}`,
  );
  return Math.max(byActor, byAddress);
}

export type SpendResult = { ok: true; entryId: number } | { ok: false; used: number };

/**
 * Check-and-debit under a per-actor advisory lock, so two concurrent requests
 * cannot both pass the check with one credit left. The lock is released when
 * the transaction ends.
 */
async function spend(
  db: Database,
  actor: CreditActor,
  kind: Exclude<CreditKind, 'refund'>,
  limit: number,
): Promise<SpendResult> {
  const pool: CreditPool = kind === 'create' ? 'create' : 'model';

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`credits:${actor.id}`}::text))`);
    if (actor.type === 'guest' && actor.ipHash != null) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`credits-ip:${actor.ipHash}`}::text))`,
      );
    }

    const spent = await used(tx, actor, pool);
    if (spent >= limit) return { ok: false, used: spent };

    const [entry] = await tx
      .insert(creditLedger)
      .values({
        actorType: actor.type,
        actorId: actor.id,
        ipHash: actor.type === 'guest' ? (actor.ipHash ?? null) : null,
        kind,
        amount: -1,
      })
      .returning({ id: creditLedger.id });

    if (entry === undefined) throw new Error('ledger insert returned no row');
    return { ok: true, entryId: entry.id };
  });
}

/**
 * Reverses a debit with a compensating entry. Idempotent: a debit that already
 * has a refund is left alone, so a retried failure path cannot mint credits.
 */
async function refund(db: Database, entryId: number): Promise<void> {
  await db.transaction(async (tx) => {
    const [debit] = await tx
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.id, entryId))
      .for('update');
    if (debit === undefined || debit.kind === 'refund') return;

    const [existing] = await tx
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(and(eq(creditLedger.refId, entryId), eq(creditLedger.kind, 'refund')));
    if (existing !== undefined) return;

    await tx.insert(creditLedger).values({
      actorType: debit.actorType,
      actorId: debit.actorId,
      ipHash: debit.ipHash,
      kind: 'refund',
      amount: -debit.amount,
      refId: entryId,
    });
  });
}

/** Model calls made today by everyone, for the global ceiling. */
async function modelCallsToday(db: Executor): Promise<number> {
  return usedBy(db, 'model', sql`true`);
}

export interface AdminOverview {
  users: number;
  publicPrompts: number;
  privatePrompts: number;
  hiddenPrompts: number;
  openReports: number;
  modelCallsToday: number;
}

/** Headline numbers for the moderation page. Counts only; no private content. */
async function overview(db: Database): Promise<AdminOverview> {
  const result = await db.execute<Omit<AdminOverview, 'modelCallsToday'>>(sql`
    SELECT
      (SELECT count(*)::int FROM users) AS "users",
      (SELECT count(*)::int FROM prompts WHERE visibility = 'public' AND status = 'active') AS "publicPrompts",
      (SELECT count(*)::int FROM prompts WHERE visibility = 'private' AND status <> 'deleted') AS "privatePrompts",
      (SELECT count(*)::int FROM prompts WHERE status = 'hidden') AS "hiddenPrompts",
      (SELECT count(*)::int FROM reports WHERE resolved_at IS NULL) AS "openReports"
  `);
  const row = result.rows[0];
  if (row === undefined) throw new Error('overview query returned no row');
  return { ...row, modelCallsToday: await modelCallsToday(db) };
}

export const voteRepo = { addVote, removeVote };
export const adminRepo = { overview };
export const reportRepo = { addReport, listReported, resolveReports };
export const creditRepo = { used, spend, refund, modelCallsToday };
