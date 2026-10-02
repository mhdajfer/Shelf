'use client';

import { Lightbulb, Scissors, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { SuggestDto, SuggestionDto, TightenDto } from '@shelf/shared';

import { PromptBody } from '@/components/prompt-body';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/api-error';
import { modelAllowance, useCredits } from '@/lib/credits';

/**
 * The two model-backed helpers beside the editor. Neither changes the prompt
 * on its own: Tighten proposes a rewrite the author accepts or discards, and
 * Suggest lists ideas for the author to act on.
 */
export function EditorTools({
  body,
  onReplace,
  onSuggestions,
}: {
  body: string;
  onReplace: (body: string) => void;
  onSuggestions: (suggestions: SuggestionDto[]) => void;
}) {
  const { credits, setCredits } = useCredits();
  const [busy, setBusy] = useState<'tighten' | 'suggest' | null>(null);
  const [proposal, setProposal] = useState<TightenDto | null>(null);

  const empty = body.trim() === '';
  const exhausted = credits !== null && credits.model.remaining === 0;
  const disabled = busy !== null || empty || exhausted;

  async function tighten() {
    setBusy('tighten');
    try {
      const result = await api<TightenDto>('/tools/tighten', { method: 'POST', body: { body } });
      setCredits(result.credits);
      if (result.body === body.trim()) {
        toast.message('Nothing to tighten', { description: 'The model returned it unchanged.' });
      } else {
        setProposal(result);
      }
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function suggest() {
    setBusy('suggest');
    try {
      const result = await api<SuggestDto>('/tools/suggest', { method: 'POST', body: { body } });
      setCredits(result.credits);
      onSuggestions(result.suggestions);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  const saved = proposal === null ? 0 : body.length - proposal.body.length;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" onClick={() => void tighten()} disabled={disabled}>
        <Scissors />
        {busy === 'tighten' ? 'Tightening…' : 'Tighten'}
      </Button>
      <Button size="sm" onClick={() => void suggest()} disabled={disabled}>
        <Lightbulb />
        {busy === 'suggest' ? 'Thinking…' : 'Suggest improvements'}
      </Button>
      <span className="text-sm text-text-subtle">
        {exhausted
          ? 'You have used today’s test runs.'
          : `Each uses one test run. ${modelAllowance(credits) ?? ''}`}
      </span>

      {proposal !== null && (
        <Dialog open onOpenChange={(open) => !open && setProposal(null)}>
          <DialogContent
            title="Tightened version"
            description={
              saved > 0
                ? `${String(saved)} characters shorter. Read it before accepting: the model can drop a detail that mattered.`
                : 'Read it before accepting: the model can drop a detail that mattered.'
            }
            className="max-w-2xl"
          >
            {proposal.droppedVariables.length > 0 && (
              <p
                role="alert"
                className="rounded-md border border-warning px-3 py-2 text-sm text-warning"
              >
                This version lost{' '}
                {proposal.droppedVariables.length === 1 ? 'a variable' : 'variables'}:{' '}
                <span className="font-mono">{proposal.droppedVariables.join(', ')}</span>. Accepting
                it removes {proposal.droppedVariables.length === 1 ? 'that input' : 'those inputs'}.
              </p>
            )}
            <PromptBody body={proposal.body} className="max-h-[50vh] overflow-y-auto" />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setProposal(null)}>
                Keep mine
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  onReplace(proposal.body);
                  setProposal(null);
                }}
              >
                Use this version
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

export function SuggestionList({
  suggestions,
  onDismiss,
}: {
  suggestions: SuggestionDto[];
  onDismiss: () => void;
}) {
  return (
    <section
      aria-labelledby="suggestions-heading"
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="suggestions-heading" className="font-medium">
          Suggestions
        </h2>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss suggestions"
          className="rounded-sm p-1 text-text-subtle hover:bg-surface-sunken hover:text-text"
        >
          <X className="size-4" />
        </button>
      </div>
      <ul className="flex flex-col gap-3 text-sm">
        {suggestions.map((suggestion) => (
          <li key={suggestion.title} className="flex flex-col gap-0.5">
            <span className="font-medium">{suggestion.title}</span>
            <span className="text-text-muted">{suggestion.detail}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
