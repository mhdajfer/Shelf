'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, Square } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import type { RunDto } from '@shelf/shared';

import { CopyButton } from '@/components/copy-button';
import { ModelOutput } from '@/components/model-output';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api-client';
import { ApiError, errorMessage } from '@/lib/api-error';
import { modelAllowance, useCredits } from '@/lib/credits';
import { routes } from '@/lib/routes';
import { streamRun } from '@/lib/run-stream';
import { useSession } from '@/lib/session';
import { formatDateTime } from '@/lib/utils';

export interface RunTarget {
  promptId: string;
  versionId: string;
}

type RunState =
  | { status: 'idle' }
  | { status: 'running'; output: string }
  | { status: 'done'; run: RunDto; model: string }
  | { status: 'stopped'; output: string }
  | { status: 'failed'; output: string; message: string; outOfCredits: boolean };

export const runMeta = (run: RunDto, model?: string): string =>
  [
    `Version ${String(run.versionNumber)}`,
    run.latencyMs === null ? null : `${(run.latencyMs / 1000).toFixed(1)}s`,
    run.tokensIn === null || run.tokensOut === null
      ? null
      : `${String(run.tokensIn)} tokens in, ${String(run.tokensOut)} out`,
    model ?? null,
  ]
    .filter((part) => part !== null)
    .join(' · ');

function EarlierRuns({ promptId, exclude }: { promptId: string; exclude: string | null }) {
  const { data } = useQuery({
    queryKey: ['runs', promptId],
    queryFn: () => api<{ runs: RunDto[] }>(`/prompts/${promptId}/runs`),
  });
  const runs = (data?.runs ?? []).filter((run) => run.id !== exclude);
  if (runs.length === 0) return null;

  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-text-muted hover:text-text">
        Your earlier runs ({runs.length})
      </summary>
      <ul className="mt-2 flex flex-col gap-3">
        {runs.map((run) => {
          const inputs = Object.entries(run.inputs);
          return (
            <li key={run.id} className="flex flex-col gap-1.5 border-t border-border pt-3">
              <p className="text-text-subtle">
                {formatDateTime(run.createdAt)} · {runMeta(run)}
                {run.status !== 'ok' && (
                  <span className="text-danger">
                    {' · '}
                    {run.status === 'timeout' ? 'timed out' : 'failed'}
                  </span>
                )}
              </p>
              {inputs.length > 0 && (
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 text-text-muted">
                  {inputs.map(([name, value]) => (
                    <div key={name} className="contents">
                      <dt className="font-mono text-[0.8125rem]">{name}</dt>
                      <dd className="truncate">{value === '' ? '(empty)' : value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {run.output !== null && (
                <ModelOutput
                  text={run.output}
                  className="max-h-48 overflow-y-auto rounded-md border border-border bg-surface-sunken p-3"
                />
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/**
 * Sends the prompt, with the values filled in above, to the model and streams
 * the answer in. The inputs come from the caller so that the text copied from
 * the panel and the text sent to the model are the same text.
 */
export function RunSection({
  target,
  inputs,
  missing,
}: {
  target: RunTarget;
  /** Only the values the reader actually supplied; the API applies defaults. */
  inputs: Record<string, string>;
  /** Variables with neither a value nor a default. A run would send them blank. */
  missing: string[];
}) {
  const { user, features } = useSession();
  const queryClient = useQueryClient();
  const { credits, setCredits } = useCredits();
  const [state, setState] = useState<RunState>({ status: 'idle' });
  const controller = useRef<AbortController | null>(null);

  // Leaving the page stops the call rather than letting it run to nobody.
  useEffect(() => () => controller.current?.abort(), []);

  async function run() {
    const abort = new AbortController();
    controller.current = abort;
    let output = '';
    setState({ status: 'running', output });

    try {
      const final = await streamRun(
        { ...target, inputs },
        {
          signal: abort.signal,
          onDelta: (text) => {
            output += text;
            setState({ status: 'running', output });
          },
        },
      );
      setCredits(final.credits);
      if (final.type === 'done') {
        setState({ status: 'done', run: final.run, model: final.model });
      } else {
        setState({ status: 'failed', output, message: final.message, outOfCredits: false });
      }
    } catch (error) {
      if (abort.signal.aborted) {
        setState({ status: 'stopped', output });
      } else {
        setState({
          status: 'failed',
          output,
          message: errorMessage(error),
          outOfCredits: error instanceof ApiError && error.status === 402,
        });
      }
    } finally {
      controller.current = null;
      void queryClient.invalidateQueries({ queryKey: ['runs', target.promptId] });
      void queryClient.invalidateQueries({ queryKey: ['credits'] });
    }
  }

  const running = state.status === 'running';
  const output =
    state.status === 'done'
      ? (state.run.output ?? '')
      : state.status === 'idle'
        ? ''
        : state.output;
  const allowance = modelAllowance(credits);
  const exhausted = credits !== null && credits.model.remaining === 0;

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="font-medium">Test run</h3>
        {allowance !== null && <span className="text-sm text-text-subtle">{allowance}</span>}
        <div className="ml-auto">
          {running ? (
            <Button size="sm" onClick={() => controller.current?.abort()}>
              <Square />
              Stop
            </Button>
          ) : (
            <Button size="sm" onClick={() => void run()} disabled={exhausted || missing.length > 0}>
              <Play />
              {state.status === 'idle' ? 'Run' : 'Run again'}
            </Button>
          )}
        </div>
      </div>

      {features.simulatedModel && (
        <p className="text-sm text-text-subtle">
          No model key is configured, so answers here are simulated.
        </p>
      )}

      {missing.length > 0 && !running && (
        <p className="text-sm text-text-muted">
          Fill in <span className="font-mono">{missing.join(', ')}</span> to run it. A blank input
          would spend a test run on a prompt with holes in it.
        </p>
      )}

      {exhausted && state.status === 'idle' && (
        <p className="text-sm text-text-muted">
          You have used today&apos;s test runs. They reset at midnight UTC.
          {user === null && (
            <>
              {' '}
              <Link
                href={routes.signIn(routes.prompt(target.promptId))}
                className="text-accent underline"
              >
                Sign in
              </Link>{' '}
              for a larger allowance.
            </>
          )}
        </p>
      )}

      {state.status === 'failed' && (
        <p role="alert" className="rounded-md border border-danger px-3 py-2 text-sm text-danger">
          {state.message}
          {state.outOfCredits && user === null && (
            <>
              {' '}
              <Link href={routes.signIn(routes.prompt(target.promptId))} className="underline">
                Sign in
              </Link>
            </>
          )}
        </p>
      )}

      {(running || output !== '') && (
        <div className="flex flex-col gap-2">
          <ModelOutput
            text={output === '' ? 'Waiting for the model…' : output}
            className="max-h-96 overflow-y-auto rounded-md border border-border bg-surface-sunken p-3"
          />
          {/* Announced once, when the answer is complete, not on every token. */}
          <p role="status" className="flex flex-wrap items-center gap-2 text-sm text-text-subtle">
            {running && 'Receiving…'}
            {state.status === 'stopped' && 'Stopped. The credit was used.'}
            {state.status === 'done' && (
              <>
                {runMeta(state.run, state.model)}
                <CopyButton text={output} variant="ghost" size="sm" label="Copy answer" />
              </>
            )}
          </p>
        </div>
      )}

      <EarlierRuns
        promptId={target.promptId}
        exclude={state.status === 'done' ? state.run.id : null}
      />
    </div>
  );
}
