'use client';

import { useId, useMemo, useState } from 'react';

import { initialValues, missingVariables, parseTemplate, renderParsed } from '@shelf/shared';

import { CopyButton } from '@/components/copy-button';
import { Input, Label, Textarea } from '@/components/ui/field';

/** Long defaults and paste-heavy names get a multi-line field. */
const MULTILINE =
  /text|content|notes|draft|code|body|paragraph|document|source|input|changelog|transcript|diff/i;

/**
 * Fill in a prompt's variables and copy the result. The rendered text is built
 * by the same renderer the API uses for test runs, so what is copied here is
 * exactly what a run would send.
 */
export function UsePanel({
  body,
  heading = 'Use this prompt',
}: {
  body: string;
  heading?: string;
}) {
  const id = useId();
  const parsed = useMemo(() => parseTemplate(body), [body]);
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(parsed));

  // A field the reader has not touched and that has no default counts as
  // missing, so its placeholder stays visible in the preview.
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const supplied = useMemo(
    () =>
      Object.fromEntries(
        parsed.variables.map((variable) => [
          variable.name,
          touched.has(variable.name) || variable.defaultValue !== undefined
            ? values[variable.name]
            : undefined,
        ]),
      ),
    [parsed, values, touched],
  );

  const rendered = renderParsed(parsed, supplied, { onMissing: 'keep' });
  const missing = missingVariables(parsed, supplied);

  function update(name: string, value: string) {
    setValues((current) => ({ ...current, [name]: value }));
    setTouched((current) => new Set(current).add(name));
  }

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
        <div className="flex flex-col gap-3">
          {parsed.variables.map((variable) => {
            const fieldId = `${id}-${variable.name}`;
            // A variable added after the panel mounted has no entry yet, so its
            // default stands in until the reader types.
            const current = values[variable.name] ?? variable.defaultValue ?? '';
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
                    onChange={(event) => update(variable.name, event.target.value)}
                    rows={3}
                  />
                ) : (
                  <Input
                    id={fieldId}
                    value={current}
                    onChange={(event) => update(variable.name, event.target.value)}
                  />
                )}
              </div>
            );
          })}
        </div>
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
    </section>
  );
}
