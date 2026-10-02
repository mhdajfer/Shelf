import { diffLines } from 'diff';
import { Router, type Request, type Response } from 'express';

import {
  creditRepo,
  promptRepo,
  reportRepo,
  voteRepo,
  type CreatePromptInput,
  type Database,
  type Participant,
  type PromptSummary,
} from '@shelf/db';
import {
  createPromptSchema,
  extractVariables,
  forkPromptSchema,
  LIMITS,
  publicListQuerySchema,
  reportPromptSchema,
  shelfListQuerySchema,
  updatePromptSchema,
  type Category,
  type PromptListDto,
  type VersionDiffDto,
} from '@shelf/shared';

import { ensureGuestId, guestHandle, requireUser } from '../auth/identity.js';
import {
  toPromptDetailDto,
  toPromptDtos,
  toVersionDto,
  uuidParam,
  withinEditWindow,
} from '../http/dto.js';
import { AppError, badRequest, notFound, unauthorized } from '../http/errors.js';
import type { BotCheck } from '../security/botCheck.js';
import { assertPublishable } from '../security/profanity.js';
import type { RateLimits } from '../security/rateLimit.js';
import { creditBalances, spendCredit } from '../services/credits.js';

export interface PromptDeps {
  db: Database;
  limits: RateLimits;
  botCheck: BotCheck;
}

const forbidden = (message: string): AppError => new AppError('forbidden', message);

const clientKey = (req: Request): string => req.user?.id ?? req.ip ?? 'unknown';

function assertVerified(req: Request): void {
  if (req.user !== undefined && !req.user.emailVerified) {
    throw forbidden('Confirm your email address before publishing to the public shelf.');
  }
}

/** Users vote and report as themselves; a guest gets an id on first use. */
function participant(req: Request, res: Response): Participant {
  if (req.user !== undefined) return { type: 'user', userId: req.user.id };
  return { type: 'guest', guestId: ensureGuestId(req, res) };
}

export function createPromptRouter(deps: PromptDeps): Router {
  const { db, limits, botCheck } = deps;
  const router = Router();

  /** 404 for a prompt the actor cannot read, whether or not it exists. */
  async function readable(req: Request): Promise<PromptSummary> {
    const prompt = await promptRepo.findVisible(db, req.actor, uuidParam(req, 'id'));
    if (prompt === null) throw notFound('That prompt does not exist.');
    return prompt;
  }

  /**
   * Readable first, then owned: someone else's private prompt is a 404, while
   * someone else's public prompt is an honest 403.
   */
  async function editable(req: Request): Promise<PromptSummary> {
    const prompt = await readable(req);
    const owned = await promptRepo.findOwned(db, req.actor, prompt.id);
    if (owned === null) throw forbidden('You can only change your own prompts.');
    if (!withinEditWindow(owned)) {
      throw forbidden(
        'Guest prompts can be changed for 24 hours after posting. Sign in to keep editing your work.',
      );
    }
    return owned;
  }

  async function detail(req: Request, res: Response, id: string, status = 200): Promise<void> {
    const prompt = await promptRepo.findVisible(db, req.actor, id);
    if (prompt === null) throw notFound('That prompt does not exist.');
    res.status(status).json({ prompt: await toPromptDetailDto(db, req.actor, prompt) });
  }

  router.get('/prompts', async (req, res) => {
    const query = publicListQuerySchema.parse(req.query);
    const options = {
      sort: query.sort,
      tags: query.tag,
      limit: query.limit,
      offset: (query.page - 1) * query.limit,
      ...(query.category === undefined ? {} : { category: query.category }),
      ...(query.model === undefined || query.model === '' ? {} : { modelHint: query.model }),
      ...(query.author === undefined || query.author === '' ? {} : { authorHandle: query.author }),
    };

    const searching = query.q !== undefined && query.q !== '';
    if (searching) await limits.consume('search', req.ip ?? 'unknown');

    const [items, total] = searching
      ? await Promise.all([
          promptRepo.searchPublic(db, { ...options, query: query.q ?? '' }),
          promptRepo.countSearchPublic(db, { ...options, query: query.q ?? '' }),
        ])
      : await Promise.all([
          promptRepo.listPublic(db, options),
          promptRepo.countPublic(db, options),
        ]);

    const body: PromptListDto = {
      items: await toPromptDtos(db, req.actor, items),
      page: query.page,
      limit: query.limit,
      total,
      hasMore: query.page * query.limit < total,
    };
    res.json(body);
  });

  router.get('/categories', async (_req, res) => {
    res.json({ categories: await promptRepo.listCategoriesWithCounts(db) });
  });

  router.get('/credits', async (req, res) => {
    res.json({ credits: await creditBalances(db, req) });
  });

  router.get('/shelf/prompts', async (req, res) => {
    const user = requireUser(req);
    const query = shelfListQuerySchema.parse(req.query);
    const offset = (query.page - 1) * query.limit;

    const items =
      query.q !== undefined && query.q !== ''
        ? await promptRepo.searchOwned(db, req.actor, {
            query: query.q,
            limit: query.limit,
            offset,
          })
        : await promptRepo.listOwned(db, req.actor, {
            limit: query.limit,
            offset,
            pinnedOnly: query.pinned,
            ...(query.collection === undefined ? {} : { collectionId: query.collection }),
          });

    res.json({
      items: await toPromptDtos(db, req.actor, items),
      page: query.page,
      limit: query.limit,
      total: await promptRepo.countOwned(db, user.id),
      hasMore: items.length === query.limit,
    });
  });

  router.post('/prompts', async (req, res) => {
    const input = createPromptSchema.parse(req.body);
    await limits.consume('write', clientKey(req));

    const base = {
      title: input.title,
      description: input.description ?? null,
      category: input.category,
      modelHint: input.modelHint ?? null,
      body: input.body,
      variables: extractVariables(input.body),
      tags: input.tags ?? [],
      note: input.note ?? null,
    };

    if (req.user !== undefined) {
      const visibility = input.visibility ?? 'private';
      if (visibility === 'public') {
        assertVerified(req);
        assertPublishable(base);
      }
      if ((await promptRepo.countOwned(db, req.user.id)) >= LIMITS.maxPromptsPerUser) {
        throw new AppError(
          'conflict',
          `Your shelf is full (${String(LIMITS.maxPromptsPerUser)} prompts). Delete some to add more.`,
        );
      }

      const id = await promptRepo.create(db, {
        ...base,
        author: { type: 'user', userId: req.user.id },
        visibility,
      });
      await detail(req, res, id, 201);
      return;
    }

    // A guest has no shelf, so there is nowhere private to put this.
    if (input.visibility === 'private') {
      throw unauthorized('Sign in to keep private prompts.');
    }
    assertPublishable(base);
    await botCheck.verify(input.turnstileToken, req.ip);

    const guestId = ensureGuestId(req, res);
    const entryId = await spendCredit(db, req, 'create');
    const guestInput: CreatePromptInput = {
      ...base,
      author: { type: 'guest', guestId, guestHandle: guestHandle(guestId) },
      visibility: 'public',
    };

    let id: string;
    try {
      id = await promptRepo.create(db, guestInput);
    } catch (error) {
      await creditRepo.refund(db, entryId);
      throw error;
    }
    await detail(req, res, id, 201);
  });

  router.get('/prompts/:id', async (req, res) => {
    const prompt = await readable(req);
    res.json({ prompt: await toPromptDetailDto(db, req.actor, prompt) });
  });

  router.patch('/prompts/:id', async (req, res) => {
    const input = updatePromptSchema.parse(req.body);
    const prompt = await editable(req);
    await limits.consume('write', clientKey(req));

    const isGuest = prompt.author.kind === 'guest';
    if (isGuest && input.visibility === 'private') {
      throw unauthorized('Sign in to keep private prompts.');
    }
    if (isGuest && input.pinned !== undefined) {
      throw unauthorized('Sign in to pin prompts.');
    }

    const visibility = input.visibility ?? prompt.visibility;
    if (visibility === 'public') {
      if (prompt.visibility !== 'public') assertVerified(req);
      assertPublishable({
        title: input.title ?? prompt.title,
        description: input.description === undefined ? prompt.description : input.description,
        tags: input.tags ?? prompt.tags,
      });
    }

    await promptRepo.updateMeta(db, prompt.id, {
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.category === undefined ? {} : { category: input.category }),
      ...(input.modelHint === undefined ? {} : { modelHint: input.modelHint }),
      ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
      ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
      ...(input.tags === undefined ? {} : { tags: input.tags }),
    });

    // A save that does not change the body is a metadata edit, not a new version.
    if (input.body !== undefined && input.body !== prompt.body) {
      await promptRepo.addVersion(db, prompt.id, {
        body: input.body,
        variables: extractVariables(input.body),
        note: input.note ?? null,
      });
    }

    await detail(req, res, prompt.id);
  });

  router.delete('/prompts/:id', async (req, res) => {
    const prompt = await editable(req);
    await limits.consume('write', clientKey(req));
    await promptRepo.setStatus(db, prompt.id, 'deleted');
    res.status(204).end();
  });

  router.get('/prompts/:id/versions', async (req, res) => {
    const versions = await promptRepo.listVersions(db, req.actor, uuidParam(req, 'id'));
    if (versions === null) throw notFound('That prompt does not exist.');
    res.json({ versions: versions.map(toVersionDto) });
  });

  router.get('/prompts/:id/versions/:versionId', async (req, res) => {
    const version = await promptRepo.findVersion(
      db,
      req.actor,
      uuidParam(req, 'id'),
      uuidParam(req, 'versionId'),
    );
    if (version === null) throw notFound('That version does not exist.');
    res.json({ version: toVersionDto(version) });
  });

  /**
   * Line diff between two versions. With no parameters it compares the current
   * version to the one before it, which is what "what changed?" usually means.
   */
  router.get('/prompts/:id/diff', async (req, res) => {
    const versions = await promptRepo.listVersions(db, req.actor, uuidParam(req, 'id'));
    if (versions === null) throw notFound('That prompt does not exist.');

    const pick = (value: unknown, fallback: number) =>
      typeof value === 'string'
        ? versions.find((version) => version.id === value || String(version.number) === value)
        : versions[fallback];

    // Newest first, so index 0 is current and index 1 is its predecessor.
    const to = pick(req.query.to, 0);
    const from = pick(req.query.from, 1) ?? to;
    if (to === undefined || from === undefined) throw notFound('That version does not exist.');

    const body: VersionDiffDto = {
      from: { id: from.id, number: from.number },
      to: { id: to.id, number: to.number },
      changes: diffLines(from.body, to.body).map((change) => ({
        value: change.value,
        added: change.added,
        removed: change.removed,
      })),
    };
    res.json(body);
  });

  router.post('/prompts/:id/versions/:versionId/restore', async (req, res) => {
    const prompt = await editable(req);
    await limits.consume('write', clientKey(req));

    const version = await promptRepo.findVersion(
      db,
      req.actor,
      prompt.id,
      uuidParam(req, 'versionId'),
    );
    if (version === null) throw notFound('That version does not exist.');

    // History is append-only: restoring writes the old body as a new version
    // rather than moving the pointer back and orphaning what came after.
    if (version.body !== prompt.body) {
      await promptRepo.addVersion(db, prompt.id, {
        body: version.body,
        variables: version.variables,
        note: `Restored version ${String(version.number)}`,
      });
    }
    await detail(req, res, prompt.id);
  });

  router.post('/prompts/:id/fork', async (req, res) => {
    const user = requireUser(req);
    const input = forkPromptSchema.parse(req.body ?? {});
    const source = await readable(req);
    await limits.consume('write', user.id);

    const visibility = input.visibility ?? 'private';
    if (visibility === 'public') assertVerified(req);
    if ((await promptRepo.countOwned(db, user.id)) >= LIMITS.maxPromptsPerUser) {
      throw new AppError(
        'conflict',
        `Your shelf is full (${String(LIMITS.maxPromptsPerUser)} prompts). Delete some to add more.`,
      );
    }

    const id = await promptRepo.create(db, {
      author: { type: 'user', userId: user.id },
      visibility,
      title: source.title,
      description: source.description,
      category: source.category as Category,
      modelHint: source.modelHint,
      body: source.body,
      variables: source.variables,
      tags: source.tags,
      forkedFromId: source.id,
      note: `Forked from ${source.author.handle}`,
    });
    await detail(req, res, id, 201);
  });

  router.get('/prompts/:id/forks', async (req, res) => {
    const prompt = await readable(req);
    const forks = await promptRepo.listForks(db, prompt.id);
    res.json({ items: await toPromptDtos(db, req.actor, forks) });
  });

  async function votable(req: Request): Promise<PromptSummary> {
    const prompt = await readable(req);
    if (prompt.visibility !== 'public' || prompt.status !== 'active') {
      throw badRequest('Only prompts on the public shelf can be upvoted.');
    }
    return prompt;
  }

  router.put('/prompts/:id/vote', async (req, res) => {
    const prompt = await votable(req);
    await limits.consume('vote', clientKey(req));
    const upvoteCount = await voteRepo.addVote(db, prompt.id, participant(req, res));
    res.json({ upvoteCount, hasVoted: true });
  });

  router.delete('/prompts/:id/vote', async (req, res) => {
    const prompt = await votable(req);
    await limits.consume('vote', clientKey(req));
    const upvoteCount = await voteRepo.removeVote(db, prompt.id, participant(req, res));
    res.json({ upvoteCount, hasVoted: false });
  });

  router.post('/prompts/:id/report', async (req, res) => {
    const input = reportPromptSchema.parse(req.body);
    const prompt = await readable(req);
    if (prompt.visibility !== 'public') {
      throw badRequest('Only prompts on the public shelf can be reported.');
    }
    if ((await promptRepo.findOwned(db, req.actor, prompt.id)) !== null) {
      throw badRequest('You cannot report your own prompt. Delete it instead.');
    }
    await limits.consume('report', clientKey(req));

    const outcome = await reportRepo.addReport(db, prompt.id, participant(req, res), input.reason);
    // Whether the report tipped the prompt into hiding is not disclosed.
    res.status(outcome.created ? 201 : 200).json({ ok: true, alreadyReported: !outcome.created });
  });

  return router;
}
