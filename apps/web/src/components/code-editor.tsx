'use client';

import {
  autocompletion,
  completionKeymap,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { EditorState, type Range } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  placeholder,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import { useEffect, useRef } from 'react';

import { parseTemplate } from '@shelf/shared';

import { cn } from '@/lib/utils';

const variableMark = Decoration.mark({ class: 'shelf-variable' });

/**
 * Marks placeholders and underlines malformed ones. Driven by the same
 * `parseTemplate` the API and the preview use, so the editor can never disagree
 * with them about what counts as a variable.
 */
function decorate(view: EditorView): DecorationSet {
  const { tokens, diagnostics } = parseTemplate(view.state.doc.toString());
  const ranges: Range<Decoration>[] = [];

  for (const token of tokens) {
    if (token.kind === 'variable') ranges.push(variableMark.range(token.start, token.end));
  }
  for (const issue of diagnostics) {
    if (issue.end > issue.start) {
      ranges.push(
        Decoration.mark({
          class: 'shelf-diagnostic',
          attributes: { title: issue.message },
        }).range(issue.start, issue.end),
      );
    }
  }
  return Decoration.set(ranges, true);
}

const templateHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = decorate(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged) this.decorations = decorate(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** After `{{`, offer the variables the prompt already uses. */
function completeVariables(context: CompletionContext): CompletionResult | null {
  const open = context.matchBefore(/\{\{[A-Za-z0-9_-]*/);
  if (open === null) return null;

  const typed = open.text.slice(2);
  const names = parseTemplate(context.state.doc.toString())
    .variables.map((variable) => variable.name)
    .filter((name) => name !== typed);
  if (names.length === 0) return null;

  return {
    from: open.from + 2,
    options: names.map((name) => ({ label: name, type: 'variable', apply: `${name}}}` })),
    validFor: /^[A-Za-z0-9_-]*$/,
  };
}

// Colours come from the design tokens, so the editor follows the theme with no
// second palette to keep in step.
const theme = EditorView.theme({
  '&': {
    color: 'var(--color-text)',
    backgroundColor: 'transparent',
    fontSize: '0.8125rem',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.6',
    minHeight: '16rem',
    maxHeight: '60vh',
  },
  '.cm-content': { padding: '12px', caretColor: 'var(--color-text)' },
  '.cm-line': { padding: '0' },
  '.cm-cursor': { borderLeftColor: 'var(--color-text)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--color-accent) 22%, transparent)',
  },
  '.cm-selectionMatch': {
    backgroundColor: 'color-mix(in srgb, var(--color-accent) 12%, transparent)',
  },
  '.cm-placeholder': { color: 'var(--color-text-subtle)' },
  '.cm-tooltip': {
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--color-surface-raised)',
    color: 'var(--color-text)',
    overflow: 'hidden',
  },
  '.cm-tooltip-autocomplete ul li': { padding: '2px 8px' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--color-accent)',
    color: 'var(--color-accent-contrast)',
  },
  '.cm-panels': {
    backgroundColor: 'var(--color-surface-sunken)',
    color: 'var(--color-text)',
    borderColor: 'var(--color-border)',
  },
  '.cm-textfield, .cm-button': {
    border: '1px solid var(--color-border-strong)',
    borderRadius: 'var(--radius-sm)',
    backgroundColor: 'var(--color-surface-raised)',
    backgroundImage: 'none',
    color: 'var(--color-text)',
  },
});

export function CodeEditor({
  value,
  onChange,
  onSave,
  label,
  describedBy,
  invalid = false,
  placeholderText,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Mod-S inside the editor. */
  onSave?: () => void;
  label: string;
  describedBy?: string | undefined;
  invalid?: boolean;
  placeholderText?: string;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // The editor is created once; the latest callbacks are read through a ref so
  // it never holds a stale closure.
  const callbacks = useRef({ onChange, onSave });
  useEffect(() => {
    callbacks.current = { onChange, onSave };
  });

  useEffect(() => {
    if (host.current === null) return;

    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          EditorView.lineWrapping,
          highlightSelectionMatches(),
          templateHighlighter,
          autocompletion({ override: [completeVariables], icons: false }),
          placeholder(placeholderText ?? ''),
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                callbacks.current.onSave?.();
                return true;
              },
            },
            ...completionKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
          ]),
          EditorView.contentAttributes.of({
            'aria-label': label,
            'aria-multiline': 'true',
            spellcheck: 'true',
            ...(describedBy === undefined ? {} : { 'aria-describedby': describedBy }),
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
          }),
          theme,
        ],
      }),
    });
    view.current = editor;

    return () => {
      editor.destroy();
      view.current = null;
    };
    // Created once. `value` is synchronised by the effect below, and the other
    // inputs are fixed for the life of a form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // An outside change (restoring a version, resetting the form) replaces the
  // document. Typing does not loop: by then the editor already holds `value`.
  useEffect(() => {
    const editor = view.current;
    if (editor === null) return;
    const current = editor.state.doc.toString();
    if (current !== value) {
      editor.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  return (
    <div
      ref={host}
      data-invalid={invalid || undefined}
      className={cn(
        'overflow-hidden rounded-md border border-border-strong bg-surface-raised focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent data-invalid:border-danger',
        className,
      )}
    />
  );
}
