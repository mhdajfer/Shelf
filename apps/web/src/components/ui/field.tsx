import type { InputHTMLAttributes, ReactNode, Ref, TextareaHTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

const control =
  'w-full rounded-md border border-border-strong bg-surface-raised px-3 text-sm text-text transition-colors duration-fast ease-shelf placeholder:text-text-subtle disabled:opacity-60 aria-invalid:border-danger';

export function Input({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input className={cn(control, 'h-9', className)} {...props} />;
}

export function Textarea({
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return (
    <textarea className={cn(control, 'min-h-20 py-2 leading-relaxed', className)} {...props} />
  );
}

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('text-sm font-medium text-text', className)} {...props} />;
}

/**
 * A labelled control with its hint and error wired up for assistive tech. The
 * caller passes the same `id` to the control and spreads `describedBy` onto it.
 */
export function Field({
  id,
  label,
  hint,
  error,
  children,
  className,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string | undefined;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error !== undefined ? (
        <p id={`${id}-error`} role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : hint !== undefined ? (
        <p id={`${id}-hint`} className="text-sm text-text-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** The aria attributes that tie a control to its Field's hint or error. */
export function describedBy(id: string, error: string | undefined, hasHint = false) {
  return {
    'aria-invalid': error !== undefined,
    ...(error !== undefined
      ? { 'aria-describedby': `${id}-error` }
      : hasHint
        ? { 'aria-describedby': `${id}-hint` }
        : {}),
  } as const;
}
