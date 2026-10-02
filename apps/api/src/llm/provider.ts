import { GoogleGenAI } from '@google/genai';

import { extractVariables } from '@shelf/shared';

import { env } from '../config/env.js';

/** What the call is for. Only the fake provider reads it, to answer in the right shape. */
export type LlmTask = 'run' | 'tighten' | 'suggest';

export interface LlmRequest {
  task: LlmTask;
  /** The user-turn text: a rendered prompt, or a prompt to be worked on. */
  prompt: string;
  system?: string;
  signal: AbortSignal;
}

export type LlmEvent =
  | { type: 'text'; text: string }
  | { type: 'usage'; tokensIn: number | null; tokensOut: number | null };

/**
 * The seam between Shelf and a model. Routes depend on this and nothing else,
 * so swapping vendors, or running with no key at all, changes one constructor.
 */
export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  stream: (request: LlmRequest) => AsyncGenerator<LlmEvent>;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });
}

const FAKE_SUGGESTIONS = [
  {
    title: 'Say what a good answer looks like',
    detail:
      'Add one sentence describing the format and length you want back, so the model does not have to guess.',
  },
  {
    title: 'Name what to do when information is missing',
    detail:
      'Tell the model to say "not stated" rather than invent a value when the input does not cover something.',
  },
  {
    title: 'Give every input a default where one makes sense',
    detail:
      'Variables with a sensible default, such as {{tone:neutral}}, make the prompt quicker to reuse.',
  },
];

function fakeReply(request: LlmRequest): string {
  switch (request.task) {
    case 'tighten':
      // A deterministic stand-in for "shorter": collapse runs of whitespace and
      // drop a few filler words, keeping every placeholder intact.
      return request.prompt
        .replace(/\b(please|kindly|very|really|just|basically)\s+/gi, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    case 'suggest': {
      const hasDefaults = extractVariables(request.prompt).some(
        (variable) => variable.defaultValue !== undefined,
      );
      return JSON.stringify(hasDefaults ? FAKE_SUGGESTIONS.slice(0, 2) : FAKE_SUGGESTIONS);
    }

    case 'run': {
      const words = request.prompt.trim().split(/\s+/).length;
      const excerpt = request.prompt.replace(/\s+/g, ' ').trim().slice(0, 240);
      return [
        'This is a simulated response. No GEMINI_API_KEY is configured, so Shelf is using its built-in fake model.',
        '',
        `The prompt it received was ${String(words)} words long and began:`,
        '',
        `"${excerpt}${request.prompt.length > 240 ? '…' : ''}"`,
        '',
        'Set GEMINI_API_KEY in .env to see a real answer here.',
      ].join('\n');
    }
  }
}

/**
 * Used when no API key is configured, and in tests. It streams, takes time,
 * honours cancellation, and reports usage, so everything around a model call
 * (credits, refunds, SSE, the UI) is exercised without a network.
 */
export function createFakeProvider(options: { chunkDelayMs?: number } = {}): LlmProvider {
  const chunkDelayMs = options.chunkDelayMs ?? 25;

  return {
    name: 'fake',
    model: 'shelf-fake-1',
    async *stream(request) {
      const reply = fakeReply(request);
      // Word-sized chunks, like a real stream.
      for (const chunk of reply.match(/\S+\s*|\s+/g) ?? []) {
        if (chunkDelayMs > 0) await sleep(chunkDelayMs, request.signal);
        if (request.signal.aborted) throw request.signal.reason as Error;
        yield { type: 'text', text: chunk };
      }
      yield {
        type: 'usage',
        tokensIn: Math.ceil(request.prompt.length / 4),
        tokensOut: Math.ceil(reply.length / 4),
      };
    },
  };
}

export function createGeminiProvider(apiKey: string): LlmProvider {
  const client = new GoogleGenAI({ apiKey });

  return {
    name: 'gemini',
    model: env.GEMINI_MODEL,
    async *stream(request) {
      const response = await client.models.generateContentStream({
        model: env.GEMINI_MODEL,
        contents: request.prompt,
        config: {
          maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
          abortSignal: request.signal,
          ...(request.system === undefined ? {} : { systemInstruction: request.system }),
        },
      });

      let tokensIn: number | null = null;
      let tokensOut: number | null = null;
      for await (const chunk of response) {
        const text = chunk.text;
        if (text !== undefined && text !== '') yield { type: 'text', text };
        // Usage arrives on the final chunks; the last value seen is the total.
        tokensIn = chunk.usageMetadata?.promptTokenCount ?? tokensIn;
        tokensOut = chunk.usageMetadata?.candidatesTokenCount ?? tokensOut;
      }
      yield { type: 'usage', tokensIn, tokensOut };
    },
  };
}

export function createLlmProvider(): LlmProvider {
  return env.GEMINI_API_KEY && !env.OFFLINE_MODE
    ? createGeminiProvider(env.GEMINI_API_KEY)
    : createFakeProvider();
}
