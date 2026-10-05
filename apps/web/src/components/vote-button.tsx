'use client';

import { ArrowBigUp } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/api-error';
import { cn, formatCount } from '@/lib/utils';

interface VoteState {
  upvoteCount: number;
  hasVoted: boolean;
}

export function VoteButton({
  promptId,
  initialCount,
  initialVoted,
  disabled = false,
}: {
  promptId: string;
  initialCount: number;
  initialVoted: boolean;
  /** Private and hidden prompts are not votable; the count still shows. */
  disabled?: boolean;
}) {
  const [state, setState] = useState<VoteState>({
    upvoteCount: initialCount,
    hasVoted: initialVoted,
  });
  const [pending, setPending] = useState(false);

  async function toggle() {
    if (pending) return;
    const previous = state;
    // Optimistic: the arrow answers the click, and the server's count replaces
    // the guess when it arrives.
    setState({
      hasVoted: !previous.hasVoted,
      upvoteCount: Math.max(0, previous.upvoteCount + (previous.hasVoted ? -1 : 1)),
    });
    setPending(true);
    try {
      setState(
        await api<VoteState>(`/prompts/${promptId}/vote`, {
          method: previous.hasVoted ? 'DELETE' : 'PUT',
        }),
      );
    } catch (error) {
      setState(previous);
      toast.error(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={disabled}
      aria-pressed={state.hasVoted}
      aria-label={`${state.hasVoted ? 'Remove upvote' : 'Upvote'} (${String(state.upvoteCount)})`}
      className={cn(
        'inline-flex h-8 items-center gap-1 rounded-md border border-border-strong bg-surface-raised px-2 text-sm tabular-nums transition-colors duration-fast ease-shelf hover:bg-surface-sunken disabled:pointer-events-none disabled:opacity-60',
        state.hasVoted && 'border-accent text-accent',
      )}
    >
      <ArrowBigUp className={cn('size-4', state.hasVoted && 'fill-current')} />
      {formatCount(state.upvoteCount)}
    </button>
  );
}
