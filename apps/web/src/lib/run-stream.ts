import type { RunInput, RunStreamEvent } from '@shelf/shared';

import { API_BASE, csrfToken } from './api-client';
import { toApiError } from './api-error';

type Final = Extract<RunStreamEvent, { type: 'done' | 'error' }>;

/**
 * Starts a test run and reports text as it arrives. Resolves with the closing
 * event. A refusal before the stream opens (no credits, not found, rate limit)
 * is an ordinary HTTP error and is thrown as ApiError, like any other request.
 *
 * EventSource cannot send a POST body or a CSRF header, so the stream is read
 * from fetch and the event framing is parsed here.
 */
export async function streamRun(
  input: RunInput,
  options: { onDelta: (text: string) => void; signal?: AbortSignal },
): Promise<Final> {
  const response = await fetch(`${API_BASE}/runs`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-csrf-token': await csrfToken(),
    },
    body: JSON.stringify(input),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  if (!response.ok || response.body === null) throw await toApiError(response);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let final: Final | null = null;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Events are separated by a blank line; the tail after the last separator
    // is an incomplete event and waits for the next chunk.
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';

    for (const block of blocks) {
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data === '') continue;

      const event = JSON.parse(data) as RunStreamEvent;
      if (event.type === 'delta') options.onDelta(event.text);
      else final = event;
    }
  }

  if (final === null) throw new Error('The run ended without a result.');
  return final;
}
