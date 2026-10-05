import { env } from '../config/env.js';
import { logger } from '../observability/logger.js';
import type { LlmProvider, LlmRequest } from './provider.js';

export type LlmFailure = 'timeout' | 'cancelled' | 'error';

export interface LlmResult {
  status: 'ok' | LlmFailure;
  output: string;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number;
}

/**
 * Runs one model call to completion under the configured timeout, reporting
 * each piece of text as it arrives. Never throws: a failure is a result, because
 * every caller has to do the same things with one (refund, record, tell the
 * user) and none of them wants a stack trace instead.
 */
export async function runLlm(
  provider: LlmProvider,
  request: Omit<LlmRequest, 'signal'>,
  options: { onText?: (text: string) => void; cancel?: AbortSignal } = {},
): Promise<LlmResult> {
  const started = Date.now();
  const timeout = AbortSignal.timeout(env.LLM_TIMEOUT_MS);
  const signal =
    options.cancel === undefined ? timeout : AbortSignal.any([timeout, options.cancel]);

  let output = '';
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;

  try {
    for await (const event of provider.stream({ ...request, signal })) {
      if (event.type === 'text') {
        output += event.text;
        options.onText?.(event.text);
      } else {
        tokensIn = event.tokensIn;
        tokensOut = event.tokensOut;
      }
    }
    return { status: 'ok', output, tokensIn, tokensOut, latencyMs: Date.now() - started };
  } catch (error) {
    const status: LlmFailure = timeout.aborted
      ? 'timeout'
      : options.cancel?.aborted === true
        ? 'cancelled'
        : 'error';
    if (status === 'error') {
      logger.warn({ err: error, provider: provider.name, task: request.task }, 'model call failed');
    }
    return { status, output, tokensIn, tokensOut, latencyMs: Date.now() - started };
  }
}

export const LLM_FAILURE_MESSAGE: Record<LlmFailure, string> = {
  timeout: 'The model took too long to answer. Your credit was returned. Try again.',
  cancelled: 'The run was stopped.',
  error: 'The model could not be reached. Your credit was returned. Try again in a moment.',
};
