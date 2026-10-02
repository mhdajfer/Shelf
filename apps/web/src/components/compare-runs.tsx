'use client';

import { Play } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  parseTemplate,
  type PromptVersionDto,
  type RunDto,
  type TemplateVariable,
} from '@shelf/shared';

import { ModelOutput } from '@/components/model-output';
import { runMeta } from '@/components/run-section';
import { Button } from '@/components/ui/button';
import { definedOnly, useTemplateValues, VariableFields } from '@/components/use-panel';
import { errorMessage } from '@/lib/api-error';
import { modelAllowance, useCredits } from '@/lib/credits';
import { streamRun } from '@/lib/run-stream';

type Side =
  | { status: 'idle' }
  | { status: 'running'; output: string }
  | { status: 'done'; run: RunDto }
  | { status: 'failed'; output: string; message: string };

function Column({ version, side }: { version: PromptVersionDto; side: Side }) {
  const output =
    side.status === 'done' ? (side.run.output ?? '') : side.status === 'idle' ? '' : side.output;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h4 className="text-sm font-medium">Version {version.number}</h4>
      {side.status === 'failed' && (
        <p role="alert" className="text-sm text-danger">
          {side.message}
        </p>
      )}
      <ModelOutput
        text={
          output !== ''
            ? output
            : side.status === 'running'
              ? 'Waiting for the model…'
              : 'Not run yet.'
        }
        className="min-h-24 rounded-md border border-border bg-surface-sunken p-3"
      />
      <p role="status" className="text-sm text-text-subtle">
        {side.status === 'running' && 'Receiving…'}
        {side.status === 'done' && runMeta(side.run)}
      </p>
    </div>
  );
}

/**
 * Runs two versions of a prompt on the same inputs, side by side. A diff shows
 * what changed in the prompt; this shows what the change did to the answer.
 */
export function CompareRuns({
  promptId,
  older,
  newer,
}: {
  promptId: string;
  older: PromptVersionDto;
  newer: PromptVersionDto;
}) {
  // One set of fields covering both versions: a variable either version uses.
  const variables = useMemo(() => {
    const byName = new Map<string, TemplateVariable>();
    for (const version of [newer, older]) {
      for (const variable of parseTemplate(version.body).variables) {
        if (!byName.has(variable.name)) byName.set(variable.name, variable);
      }
    }
    return [...byName.values()];
  }, [older, newer]);

  const values = useTemplateValues(variables);
  const { credits, setCredits } = useCredits();
  const [left, setLeft] = useState<Side>({ status: 'idle' });
  const [right, setRight] = useState<Side>({ status: 'idle' });
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  const running = left.status === 'running' || right.status === 'running';
  const tooFew = credits !== null && credits.model.remaining < 2;
  const missing = variables
    .filter(
      (variable) =>
        variable.defaultValue === undefined && values.supplied[variable.name] === undefined,
    )
    .map((variable) => variable.name);

  async function runOne(
    version: PromptVersionDto,
    set: (side: Side) => void,
    signal: AbortSignal,
  ): Promise<void> {
    let output = '';
    set({ status: 'running', output });
    try {
      const final = await streamRun(
        { promptId, versionId: version.id, inputs: definedOnly(values.supplied) },
        {
          signal,
          onDelta: (text) => {
            output += text;
            set({ status: 'running', output });
          },
        },
      );
      setCredits(final.credits);
      set(
        final.type === 'done'
          ? { status: 'done', run: final.run }
          : { status: 'failed', output, message: final.message },
      );
    } catch (error) {
      set({ status: 'failed', output, message: errorMessage(error) });
    }
  }

  async function runBoth() {
    const abort = new AbortController();
    controller.current = abort;
    await Promise.all([
      runOne(older, setLeft, abort.signal),
      runOne(newer, setRight, abort.signal),
    ]);
    controller.current = null;
  }

  return (
    <section
      aria-labelledby="compare-runs"
      className="flex flex-col gap-4 rounded-lg border border-border bg-surface-raised p-4"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 id="compare-runs" className="font-medium">
          Compare the answers
        </h3>
        <span className="text-sm text-text-subtle">
          Uses two test runs.{' '}
          {modelAllowance(credits) !== null && `${modelAllowance(credits) ?? ''}.`}
        </span>
        <Button
          size="sm"
          className="ml-auto"
          onClick={() => void runBoth()}
          disabled={running || tooFew || missing.length > 0}
        >
          <Play />
          {running ? 'Running…' : 'Run both versions'}
        </Button>
      </div>

      <VariableFields variables={variables} values={values} disabled={running} />
      {missing.length > 0 && (
        <p className="text-sm text-text-muted">
          Fill in <span className="font-mono">{missing.join(', ')}</span> to run both versions.
        </p>
      )}

      {(left.status !== 'idle' || right.status !== 'idle') && (
        <div className="grid gap-4 md:grid-cols-2">
          <Column version={older} side={left} />
          <Column version={newer} side={right} />
        </div>
      )}
    </section>
  );
}
