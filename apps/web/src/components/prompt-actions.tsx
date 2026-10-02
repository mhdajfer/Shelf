'use client';

import { Flag, GitFork } from 'lucide-react';
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

export function ForkButton({ promptId }: { promptId: string }) {
  const { user } = useSession();
  const router = useRouter();
  const [pending, setPending] = useState(false);

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
      router.push(routes.prompt(prompt.id));
    } catch (error) {
      toast.error(errorMessage(error));
      setPending(false);
    }
  }

  return (
    <Button onClick={() => void fork()} disabled={pending}>
      <GitFork />
      {pending ? 'Forking…' : 'Fork'}
    </Button>
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
