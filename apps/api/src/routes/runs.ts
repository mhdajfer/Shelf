import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import {
  creditRepo,
  promptRepo,
  runRepo,
  type Database,
  type RunRecord,
  type RunStatus,
} from '@shelf/db';
import {
  extractVariables,
  parseTemplate,
  RENDERED_PROMPT_MAX,
  renderParsed,
  runSchema,
  toolSchema,
  type CreditKind,
  type RunDto,
  type RunStreamEvent,
  type SuggestDto,
  type SuggestionDto,
  type TightenDto,
} from '@shelf/shared';

import { ensureGuestId } from '../auth/identity.js';
import { env } from '../config/env.js';
import { uuidParam } from '../http/dto.js';
import { AppError, badRequest, notFound } from '../http/errors.js';
import { LLM_FAILURE_MESSAGE, runLlm, type LlmResult } from '../llm/call.js';
import type { LlmProvider, LlmTask } from '../llm/provider.js';
import type { RateLimits } from '../security/rateLimit.js';
import { creditBalances, spendCredit } from '../services/credits.js';

export interface RunDeps {
  db: Database;
  limits: RateLimits;
  llm: LlmProvider;
}

const toRunDto = (run: RunRecord): RunDto => ({
  id: run.id,
  versionId: run.promptVersionId,
  versionNumber: run.versionNumber,
  inputs: run.inputs,
  output: run.output,
  status: run.status,
  tokensIn: run.tokensIn,
  tokensOut: run.tokensOut,
  latencyMs: run.latencyMs,
  createdAt: run.createdAt.toISOString(),
});

const TIGHTEN_SYSTEM = [
  'You edit prompts that are written for language models.',
  'Rewrite the prompt you are given so that it is shorter and clearer without changing what it asks for.',
  'Remove filler, hedging, and repetition. Keep every instruction and constraint.',
  'Keep every {{placeholder}} exactly as written, including any default after a colon.',
  'Return only the rewritten prompt: no commentary, no explanation, no code fences.',
].join(' ');

const SUGGEST_SYSTEM = [
  'You review prompts that are written for language models.',
  'Suggest up to five specific improvements to the prompt you are given.',
  'Each suggestion must be actionable and refer to this prompt, not to prompts in general.',
  'Respond with a JSON array and nothing else.',
  'Each element is an object with two string fields: "title" (at most 60 characters) and "detail" (one or two sentences).',
].join(' ');

const suggestionsSchema = z
  .array(
    z.object({
      title: z.string().trim().min(1).max(120),
      detail: z.string().trim().min(1).max(600),
    }),
  )
  .min(1)
  .transform((items) => items.slice(0, 5));

/** Models wrap JSON in prose or fences often enough to plan for it. */
function parseSuggestions(output: string): SuggestionDto[] | null {
  const start = output.indexOf('[');
  const end = output.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = suggestionsSchema.safeParse(JSON.parse(output.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const stripFences = (output: string): string =>
  output
    .trim()
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/\n?```$/, '')
    .trim();

export function createRunRouter(deps: RunDeps): Router {
  const { db, limits, llm } = deps;
  const router = Router();

  const clientKey = (req: Request): string => req.user?.id ?? req.ip ?? 'unknown';

  /** Every check that can refuse a model call, in the order that costs least. */
  async function admit(req: Request, res: Response, kind: Exclude<CreditKind, 'refund'>) {
    await limits.consume('model', clientKey(req));

    // One ceiling across everybody, so a burst of guests cannot spend the whole
    // free model quota. Checked before the debit, so nobody pays for a refusal.
    if ((await creditRepo.modelCallsToday(db)) >= env.LLM_GLOBAL_DAILY_CAP) {
      throw new AppError(
        'upstream_unavailable',
        'Shelf has used its model budget for today. Test runs are back at midnight UTC.',
      );
    }

    // A guest needs an identity before the debit, so the run is attributed.
    if (req.user === undefined) ensureGuestId(req, res);
    return spendCredit(db, req, kind);
  }

  /** Runs a tool to completion; on any failure the credit goes back. */
  async function runTool(
    req: Request,
    res: Response,
    task: Exclude<LlmTask, 'run'>,
    system: string,
    body: string,
  ): Promise<{ result: LlmResult; entryId: number }> {
    const entryId = await admit(req, res, 'tool');
    const result = await runLlm(llm, { task, prompt: body, system });
    if (result.status !== 'ok' || result.output.trim() === '') {
      await creditRepo.refund(db, entryId);
      throw new AppError(
        'upstream_unavailable',
        result.status === 'ok'
          ? 'The model returned nothing. Your credit was returned. Try again.'
          : LLM_FAILURE_MESSAGE[result.status],
      );
    }
    return { result, entryId };
  }

  /**
   * Streams one test run as server-sent events. Everything that can refuse the
   * run happens before the first byte, so a refusal is an ordinary JSON error
   * with a real status code; once the stream is open, failure is an `error`
   * event instead.
   */
  router.post('/runs', async (req, res) => {
    const input = runSchema.parse(req.body);

    // Both lookups go through the visibility filter. An unreadable prompt and
    // an unknown one get the same 404, as everywhere else.
    const prompt = await promptRepo.findVisible(db, req.actor, input.promptId);
    if (prompt === null) throw notFound('That prompt does not exist.');
    const versionId = input.versionId ?? prompt.currentVersionId;
    const version =
      versionId === null ? null : await promptRepo.findVersion(db, req.actor, prompt.id, versionId);
    if (version === null) throw notFound('That version does not exist.');

    const parsed = parseTemplate(version.body);
    // Only this version's variables are used; anything else in the request is
    // dropped rather than stored.
    const inputs: Record<string, string> = {};
    for (const variable of parsed.variables) {
      const value = input.inputs[variable.name];
      if (value !== undefined) inputs[variable.name] = value;
    }
    const rendered = renderParsed(parsed, inputs, { onMissing: 'empty' });
    if (rendered.trim() === '') throw badRequest('There is nothing to send: the prompt is empty.');
    if (rendered.length > RENDERED_PROMPT_MAX) {
      throw badRequest(
        `With its inputs filled in, the prompt is ${rendered.length.toLocaleString('en')} characters. The limit is ${RENDERED_PROMPT_MAX.toLocaleString('en')}.`,
      );
    }

    const entryId = await admit(req, res, 'run');
    const actor =
      req.user !== undefined
        ? { type: 'user' as const, id: req.user.id }
        : { type: 'guest' as const, id: req.guestId ?? 'anonymous' };

    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Tells nginx-style proxies not to buffer the stream.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const send = (event: RunStreamEvent): void => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    // Closing the tab stops the model call instead of paying for the rest.
    const cancel = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) cancel.abort(new Error('client disconnected'));
    });

    const result = await runLlm(
      llm,
      { task: 'run', prompt: rendered },
      { onText: (text) => send({ type: 'delta', text }), cancel: cancel.signal },
    );

    // A stopped run is not refunded: the model was called, and otherwise
    // "start, read, stop" would be a free run.
    if (result.status === 'timeout' || result.status === 'error') {
      await creditRepo.refund(db, entryId);
    }

    const status: RunStatus =
      result.status === 'ok' ? 'ok' : result.status === 'timeout' ? 'timeout' : 'error';
    const runId = await runRepo.record(db, {
      promptVersionId: version.id,
      actorType: actor.type,
      actorId: actor.id,
      inputs,
      output: result.output === '' ? null : result.output,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      latencyMs: result.latencyMs,
      status,
      errorCode: result.status === 'ok' ? null : result.status,
    });

    if (!res.writableEnded && !cancel.signal.aborted) {
      const credits = await creditBalances(db, req);
      if (result.status === 'ok') {
        send({
          type: 'done',
          model: llm.model,
          credits,
          run: {
            id: runId,
            versionId: version.id,
            versionNumber: version.number,
            inputs,
            output: result.output,
            status: 'ok',
            tokensIn: result.tokensIn,
            tokensOut: result.tokensOut,
            latencyMs: result.latencyMs,
            createdAt: new Date().toISOString(),
          },
        });
      } else {
        send({
          type: 'error',
          code: result.status,
          message: LLM_FAILURE_MESSAGE[result.status],
          credits,
        });
      }
      res.end();
    }
  });

  /** Your own runs of a prompt. Nobody else's: a run holds what its author typed. */
  router.get('/prompts/:id/runs', async (req, res) => {
    const prompt = await promptRepo.findVisible(db, req.actor, uuidParam(req, 'id'));
    if (prompt === null) throw notFound('That prompt does not exist.');

    const actor =
      req.user !== undefined
        ? { type: 'user' as const, id: req.user.id }
        : req.guestId !== undefined
          ? { type: 'guest' as const, id: req.guestId }
          : null;
    const runs = actor === null ? [] : await runRepo.listForActor(db, actor, prompt.id);
    res.json({ runs: runs.map(toRunDto) });
  });

  router.post('/tools/tighten', async (req, res) => {
    const { body } = toolSchema.parse(req.body);
    const { result } = await runTool(req, res, 'tighten', TIGHTEN_SYSTEM, body);

    const tightened = stripFences(result.output);
    const kept = new Set(extractVariables(tightened).map((variable) => variable.name));
    const response: TightenDto = {
      body: tightened,
      // The instruction says to keep placeholders; this checks that it did.
      droppedVariables: extractVariables(body)
        .map((variable) => variable.name)
        .filter((name) => !kept.has(name)),
      credits: await creditBalances(db, req),
    };
    res.json(response);
  });

  router.post('/tools/suggest', async (req, res) => {
    const { body } = toolSchema.parse(req.body);
    const { result, entryId } = await runTool(req, res, 'suggest', SUGGEST_SYSTEM, body);

    const suggestions = parseSuggestions(result.output);
    if (suggestions === null) {
      await creditRepo.refund(db, entryId);
      throw new AppError(
        'upstream_unavailable',
        'The model answered in a form Shelf could not read. Your credit was returned. Try again.',
      );
    }

    const response: SuggestDto = { suggestions, credits: await creditBalances(db, req) };
    res.json(response);
  });

  return router;
}
