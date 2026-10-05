import { Router } from 'express';

import {
  collectionRepo,
  promptRepo,
  uniqueViolation,
  type Database,
  type PromptSummary,
} from '@shelf/db';
import {
  CATEGORY_LABELS,
  EXPORT_FORMAT,
  EXPORT_VERSION,
  extractVariables,
  importEnvelopeSchema,
  importPromptSchema,
  LIMITS,
  type Category,
  type ImportResultDto,
  type ShelfExport,
} from '@shelf/shared';

import { requireUser } from '../auth/identity.js';
import { uuidParam } from '../http/dto.js';
import { notFound } from '../http/errors.js';
import type { RateLimits } from '../security/rateLimit.js';

/** A fence longer than any run of backticks in the body, so the body cannot close it. */
function fenceFor(body: string): string {
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

function toMarkdown(prompt: PromptSummary): string {
  const fence = fenceFor(prompt.body);
  const lines = [
    `# ${prompt.title}`,
    '',
    ...(prompt.description === null ? [] : [prompt.description, '']),
    `- Category: ${CATEGORY_LABELS[prompt.category as Category] ?? prompt.category}`,
    ...(prompt.tags.length === 0 ? [] : [`- Tags: ${prompt.tags.join(', ')}`]),
    ...(prompt.modelHint === null ? [] : [`- Written for: ${prompt.modelHint}`]),
    `- Author: ${prompt.author.handle}`,
    `- Version: ${String(prompt.versionNumber)}`,
    ...(prompt.variables.length === 0
      ? []
      : [`- Variables: ${prompt.variables.map((variable) => variable.name).join(', ')}`]),
    '',
    `${fence}text`,
    prompt.body,
    fence,
    '',
  ];
  return lines.join('\n');
}

const slug = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'prompt';

export function createTransferRouter(deps: { db: Database; limits: RateLimits }): Router {
  const { db, limits } = deps;
  const router = Router();

  /** The whole shelf, with history. Only ever the caller's own. */
  router.get('/export', async (req, res) => {
    const user = requireUser(req);
    await limits.consume('write', user.id);

    const prompts = await promptRepo.exportOwned(db, user.id);
    const body: ShelfExport = {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      prompts: prompts.map((prompt) => ({
        ...prompt,
        versions: prompt.versions.map((version) => ({
          ...version,
          createdAt: version.createdAt.toISOString(),
        })),
      })),
    };

    const date = body.exportedAt.slice(0, 10);
    res
      .set('Content-Disposition', `attachment; filename="shelf-export-${date}.json"`)
      .set('Cache-Control', 'no-store')
      .json(body);
  });

  /** One prompt as a Markdown file. Goes through the same visibility filter as reading it. */
  router.get('/prompts/:id/export', async (req, res) => {
    const prompt = await promptRepo.findVisible(db, req.actor, uuidParam(req, 'id'));
    if (prompt === null) throw notFound('That prompt does not exist.');

    res
      .set('Content-Type', 'text/markdown; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="${slug(prompt.title)}.md"`)
      .set('Cache-Control', 'no-store')
      .send(toMarkdown(prompt));
  });

  /**
   * Imports an export file. Everything arrives private, whatever the file says:
   * publishing is a decision the owner makes per prompt, with the checks that
   * go with it, not a side effect of an upload.
   */
  router.post('/import', async (req, res) => {
    const user = requireUser(req);
    await limits.consume('write', user.id);
    const envelope = importEnvelopeSchema.parse(req.body);

    const result: ImportResultDto = { imported: 0, skipped: [] };
    let room = LIMITS.maxPromptsPerUser - (await promptRepo.countOwned(db, user.id));

    const existing = await collectionRepo.listCollections(db, req.actor);
    const collectionIds = new Map(existing.map((collection) => [collection.name, collection.id]));

    for (const [index, raw] of envelope.prompts.entries()) {
      const title =
        typeof (raw as { title?: unknown } | null)?.title === 'string'
          ? (raw as { title: string }).title.slice(0, LIMITS.titleMax)
          : null;

      const parsed = importPromptSchema.safeParse(raw);
      if (!parsed.success) {
        result.skipped.push({
          index,
          title,
          reason: parsed.error.issues[0]?.message ?? 'Not a valid prompt.',
        });
        continue;
      }
      if (room <= 0) {
        result.skipped.push({ index, title, reason: 'Your shelf is full.' });
        continue;
      }

      const prompt = parsed.data;
      const [first, ...rest] = prompt.versions;
      if (first === undefined) continue;

      const id = await promptRepo.create(db, {
        author: { type: 'user', userId: user.id },
        visibility: 'private',
        title: prompt.title,
        description: prompt.description,
        category: prompt.category,
        modelHint: prompt.modelHint,
        body: first.body,
        variables: extractVariables(first.body),
        tags: prompt.tags,
        note: first.note,
      });
      // Replayed in order, so the imported prompt has the same history.
      for (const version of rest) {
        await promptRepo.addVersion(db, id, {
          body: version.body,
          variables: extractVariables(version.body),
          note: version.note,
        });
      }
      if (prompt.pinned) await promptRepo.updateMeta(db, id, { pinned: true });

      for (const name of prompt.collections) {
        let collectionId = collectionIds.get(name);
        if (collectionId === undefined) {
          try {
            collectionId = await collectionRepo.createCollection(db, user.id, name);
            collectionIds.set(name, collectionId);
          } catch (error) {
            // Created by a concurrent import; skip the filing, keep the prompt.
            if (uniqueViolation(error) === null) throw error;
            continue;
          }
        }
        await collectionRepo.addItem(db, user.id, collectionId, id);
      }

      result.imported += 1;
      room -= 1;
    }

    res.status(result.imported > 0 ? 201 : 200).json(result);
  });

  return router;
}
