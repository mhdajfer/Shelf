'use client';

import { useId, useMemo, useState } from 'react';

import {
  missingVariables,
  parseTemplate,
  renderParsed,
  type TemplateVariable,
} from '@shelf/shared';

import { CopyButton } from '@/components/copy-button';
import { RunSection, type RunTarget } from '@/components/run-section';
import { Input, Label, Textarea } from '@/components/ui/field';

/** Long defaults and paste-heavy names get a multi-line field. */
const MULTILINE =
  /text|content|notes|draft|code|body|paragraph|document|source|input|changelog|transcript|diff/i;

export interface TemplateValues {
  /** What each field currently shows: the typed value, else the default. */
  shown: (variable: TemplateVariable) => string;
  /** What to send or render with: `undefined` for a field left untouched. */
  supplied: Record<string, string | undefined>;
  update: (name: string, value: string) => void;
}

/**
 * The state behind a set of variable fields. A field the reader has not
 * touched is `undefined`, so the renderer falls back to its default, or keeps
 * the placeholder visible when there is none; a field they cleared is an empty
 * value and overrides the default.
 */
export function useTemplateValues(variables: TemplateVariable[]): TemplateValues {
  const [values, setValues] = useState<Record<string, string>>({});

  const supplied = useMemo(
    () =>
      Object.fromEntries(
        variables.map((variable) => [variable.name, values[variable.name]]),
      ) as Record<string, string | undefined>,
    [variables, values],
  );

  return {
    shown: (variable) => values[variable.name] ?? variable.defaultValue ?? '',
    supplied,
    update: (name, value) => setValues((current) => ({ ...current, [name]: value })),
  };
}

/** Untouched fields are left out, so the API applies each variable's default. */
export function definedOnly(supplied: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(supplied).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

export function VariableFields({
  variables,
  values,
  disabled = false,
}: {
  variables: TemplateVariable[];
  values: Pick<TemplateValues, 'shown' | 'update'>;
  disabled?: boolean;
}) {
  const id = useId();
  if (variables.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      {variables.map((variable) => {
        const fieldId = `${id}-${variable.name}`;
        const current = values.shown(variable);
        const multiline = MULTILINE.test(variable.name) || current.length > 60;
        return (
          <div key={variable.name} className="flex flex-col gap-1">
            <Label htmlFor={fieldId} className="font-mono text-[0.8125rem] font-normal">
              {variable.name}
            </Label>
            {multiline ? (
              <Textarea
                id={fieldId}
                value={current}
                onChange={(event) => values.update(variable.name, event.target.value)}
                rows={3}
                disabled={disabled}
              />
            ) : (
              <Input
                id={fieldId}
                value={current}
                onChange={(event) => values.update(variable.name, event.target.value)}
                disabled={disabled}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Fill in a prompt's variables and copy the result. The rendered text is built
 * by the same renderer the API uses for test runs, so what is copied here is
 * exactly what a run would send.
 */
export function UsePanel({
  body,
  heading = 'Use this prompt',
  run,
}: {
  body: string;
  heading?: string;
  /** When given, the panel can also send the filled-in prompt to the model. */
  run?: RunTarget;
}) {
  const id = useId();
  const parsed = useMemo(() => parseTemplate(body), [body]);
  const values = useTemplateValues(parsed.variables);

  const rendered = renderParsed(parsed, values.supplied, { onMissing: 'keep' });
  const missing = missingVariables(parsed, values.supplied);

  return (
    <section
      aria-labelledby={`${id}-heading`}
      className="flex flex-col gap-4 rounded-lg border border-border bg-surface-raised p-4"
    >
      <h2 id={`${id}-heading`} className="font-medium">
        {heading}
      </h2>

      {parsed.variables.length === 0 ? (
        <p className="text-sm text-text-muted">This prompt has no variables. Copy it as it is.</p>
      ) : (
        <VariableFields variables={parsed.variables} values={values} />
      )}

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm text-text-muted">Result</h3>
          <CopyButton text={rendered} variant="primary" size="sm" label="Copy result" />
        </div>
        <pre className="max-h-80 overflow-y-auto rounded-md border border-border bg-surface-sunken p-3 font-mono text-[0.8125rem] leading-relaxed break-words whitespace-pre-wrap">
          {rendered}
        </pre>
        {missing.length > 0 && (
          <p className="text-sm text-text-subtle">
            Still to fill in: <span className="font-mono">{missing.join(', ')}</span>
          </p>
        )}
      </div>

      {run !== undefined && (
        <RunSection target={run} inputs={definedOnly(values.supplied)} missing={missing} />
      )}
    </section>
  );
}
