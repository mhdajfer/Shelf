'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import type { AdminOverviewDto, ReportedPromptDto } from '@shelf/shared';

import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/api-error';
import { routes } from '@/lib/routes';
import { formatDateTime, plural } from '@/lib/utils';

function Stat({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-sm text-text-muted">{label}</dt>
      <dd className="text-2xl font-semibold tabular-nums">{value.toLocaleString('en')}</dd>
      {note !== undefined && <dd className="text-sm text-text-subtle">{note}</dd>}
    </div>
  );
}

export function Moderation() {
  const queryClient = useQueryClient();
  const overview = useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: () => api<{ overview: AdminOverviewDto }>('/admin/overview'),
  });
  const reports = useQuery({
    queryKey: ['admin', 'reports'],
    queryFn: () => api<{ reports: ReportedPromptDto[] }>('/admin/reports'),
  });
  const [removing, setRemoving] = useState<ReportedPromptDto | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function resolve(report: ReportedPromptDto, action: 'restore' | 'remove') {
    setBusy(report.promptId);
    try {
      await api(`/admin/reports/${report.promptId}/resolve`, { method: 'POST', body: { action } });
      setRemoving(null);
      toast.success(action === 'restore' ? 'Restored to the public shelf' : 'Prompt removed');
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  const stats = overview.data?.overview;
  const queue = reports.data?.reports ?? [];

  return (
    <div className="flex flex-col gap-8">
      {stats !== undefined && (
        <dl className="grid grid-cols-2 gap-6 border-y border-border py-5 sm:grid-cols-4">
          <Stat label="Open reports" value={stats.openReports} />
          <Stat
            label="Public prompts"
            value={stats.publicPrompts}
            note={`${String(stats.hiddenPrompts)} hidden`}
          />
          <Stat label="Accounts" value={stats.users} />
          <Stat
            label="Model calls today"
            value={stats.modelCallsToday}
            note={`of ${stats.modelDailyCap.toLocaleString('en')}`}
          />
        </dl>
      )}

      <section aria-labelledby="queue" className="flex flex-col gap-4">
        <h2 id="queue" className="font-medium">
          Reported prompts
        </h2>

        {reports.isError ? (
          <p role="alert" className="text-sm text-danger">
            {errorMessage(reports.error)}
          </p>
        ) : reports.isPending ? (
          <p className="text-sm text-text-muted">Loading the queue…</p>
        ) : queue.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border-strong p-8 text-center text-text-muted">
            Nothing is waiting for review.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {queue.map((report) => (
              <li
                key={report.promptId}
                className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4"
              >
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <Link
                    href={routes.prompt(report.promptId)}
                    className="font-medium hover:underline"
                  >
                    {report.title}
                  </Link>
                  <span className="text-sm text-text-muted">
                    by <span className="font-mono">{report.authorHandle}</span>
                  </span>
                  <span
                    className={
                      report.status === 'hidden'
                        ? 'text-sm text-warning'
                        : 'text-sm text-text-subtle'
                    }
                  >
                    {report.status === 'hidden' ? 'Hidden from the shelf' : 'Still visible'}
                  </span>
                </div>

                <div className="flex flex-col gap-1 text-sm">
                  <p className="text-text-subtle">
                    {plural(report.openReports, 'report')}, latest{' '}
                    {formatDateTime(report.lastReportedAt)}
                  </p>
                  <ul className="flex flex-col gap-1">
                    {report.reasons.map((reason, index) => (
                      <li
                        key={index}
                        className="border-l-2 border-border-strong pl-3 text-text-muted"
                      >
                        {reason}
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={busy === report.promptId}
                    onClick={() => void resolve(report, 'restore')}
                  >
                    {report.status === 'hidden' ? 'Restore to the shelf' : 'Dismiss reports'}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busy === report.promptId}
                    onClick={() => setRemoving(report)}
                  >
                    Remove prompt
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {removing !== null && (
        <Dialog open onOpenChange={(open) => !open && setRemoving(null)}>
          <DialogContent
            title="Remove this prompt?"
            description={`"${removing.title}" is deleted for everyone, including its author. This cannot be undone.`}
          >
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button variant="ghost">Cancel</Button>
              </DialogClose>
              <Button
                variant="danger"
                disabled={busy !== null}
                onClick={() => void resolve(removing, 'remove')}
              >
                Remove prompt
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
