import type { Request } from 'express';

import { creditRepo, type CreditActor, type CreditPool, type Database } from '@shelf/db';
import type { CreditAllowance, CreditKind, CreditsDto } from '@shelf/shared';

import { hashIp } from '../auth/identity.js';
import { env } from '../config/env.js';
import { AppError } from '../http/errors.js';

/**
 * Who the ledger charges. A visitor with no guest cookie yet is still metered,
 * by address alone, so asking for the balance does not need to mint a cookie.
 */
export function creditActor(req: Request): CreditActor {
  if (req.user !== undefined) return { type: 'user', id: req.user.id };
  return { type: 'guest', id: req.guestId ?? 'anonymous', ipHash: hashIp(req.ip) };
}

function limitFor(actor: CreditActor, pool: CreditPool): number {
  if (pool === 'create') return env.GUEST_DAILY_CREATE_CREDITS;
  return actor.type === 'user' ? env.USER_DAILY_RUN_CREDITS : env.GUEST_DAILY_RUN_CREDITS;
}

const allowance = (limit: number, used: number): CreditAllowance => ({
  limit,
  used: Math.min(used, limit),
  remaining: Math.max(limit - used, 0),
});

export async function creditBalances(db: Database, req: Request): Promise<CreditsDto> {
  const actor = creditActor(req);
  const model = await creditRepo.used(db, actor, 'model');
  return {
    create:
      actor.type === 'user'
        ? null
        : allowance(limitFor(actor, 'create'), await creditRepo.used(db, actor, 'create')),
    model: allowance(limitFor(actor, 'model'), model),
  };
}

const EXHAUSTED: Record<CreditPool, (limit: number, guest: boolean) => string> = {
  create: (limit) =>
    `Guests can add ${String(limit)} prompts a day, and you have used today's. Sign in to keep going.`,
  model: (limit, guest) =>
    guest
      ? `Guests get ${String(limit)} test runs a day, and you have used today's. Sign in for more.`
      : `You have used today's ${String(limit)} test runs. They reset at midnight UTC.`,
};

/**
 * Debits one credit or throws `insufficient_credits`. Returns the ledger entry
 * id, which the caller refunds if the work the credit paid for then fails.
 */
export async function spendCredit(
  db: Database,
  req: Request,
  kind: Exclude<CreditKind, 'refund'>,
): Promise<number> {
  const actor = creditActor(req);
  const pool: CreditPool = kind === 'create' ? 'create' : 'model';
  const limit = limitFor(actor, pool);

  const result = await creditRepo.spend(db, actor, kind, limit);
  if (!result.ok) {
    throw new AppError('insufficient_credits', EXHAUSTED[pool](limit, actor.type === 'guest'));
  }
  return result.entryId;
}
