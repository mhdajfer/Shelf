'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Flag, GitFork, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { LIMITS, type PromptDetailDto } from '@shelf/shared';

import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { describedBy, Field, Textarea } from '@/components/ui/field';
import { api } from '@/lib/api-client';
import { ApiError, errorMessage } from '@/lib/api-error';
import { routes } from '@/lib/routes';
import { useSession } from '@/lib/session';

/**
 * Fork, and its undo. A user has at most one fork of a prompt, so once they
 * have one the button becomes a link to it, with the option to remove it.
 */
export function ForkButton({ promptId, forkId }: { promptId: string; forkId: string | null }) {
  const { user } = useSession();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);

  if (user === null) {
    return (
      <Button asChild>
        <Link href={routes.signIn(routes.prompt(promptId))}>
          <GitFork />
          Sign in to fork
        </Link>
      </Button>
    );
  }

  async function fork() {
    setPending(true);
    try {
      const { prompt } = await api<{ prompt: PromptDetailDto }>(`/prompts/${promptId}/fork`, {
        method: 'POST',
      });
      toast.success('Forked to your shelf', {
        description: 'Your copy is private until you publish it.',
      });
      // Straight into the editor: the point of forking is to change it.
      router.push(routes.editPrompt(prompt.id));
    } catch (error) {
      toast.error(errorMessage(error));
      // A conflict means a fork already exists, made in another tab. Reloading
      // the page data swaps this button for the link to it.
      router.refresh();
      setPending(false);
    }
  }

  async function removeFork() {
    setPending(true);
    try {
      await api(`/prompts/${promptId}/fork`, { method: 'DELETE' });
      setConfirming(false);
      toast.success('Fork removed from your shelf');
      await queryClient.invalidateQueries({ queryKey: ['shelf'] });
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  if (forkId === null) {
    return (
      <Button onClick={() => void fork()} disabled={pending}>
        <GitFork />
        {pending ? 'Forking…' : 'Fork'}
      </Button>
    );
  }

  return (
    <>
      <Button asChild>
        <Link href={routes.prompt(forkId)}>
          <GitFork />
          Your fork
        </Link>
      </Button>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogTrigger asChild>
          <Button variant="ghost">
            <Undo2 />
            Remove fork
          </Button>
        </DialogTrigger>
        <DialogContent
          title="Remove your fork?"
          description="Your copy of this prompt, with any changes and versions you saved in it, is deleted from your shelf. The original is not affected, and you can fork it again."
        >
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost">Keep it</Button>
            </DialogClose>
            <Button variant="danger" onClick={() => void removeFork()} disabled={pending}>
              {pending ? 'Removing…' : 'Remove fork'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ReportButton({ promptId }: { promptId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    try {
      const result = await api<{ alreadyReported: boolean }>(`/prompts/${promptId}/report`, {
        method: 'POST',
        body: { reason },
      });
      setOpen(false);
      setReason('');
      toast.success(result.alreadyReported ? 'You already reported this prompt' : 'Report sent', {
        description: 'A moderator will review it.',
      });
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? (caught.details[0]?.message ?? caught.message)
          : errorMessage(caught),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost">
          <Flag />
          Report
        </Button>
      </DialogTrigger>
      <DialogContent
        title="Report this prompt"
        description="Reports go to a moderator. A prompt reported by several people is hidden until it is reviewed."
      >
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
          <Field id="report-reason" label="What is wrong with it?" error={error}>
            <Textarea
              id="report-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={LIMITS.reportReasonMax}
              rows={4}
              required
              {...describedBy('report-reason', error)}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? 'Sending…' : 'Send report'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
