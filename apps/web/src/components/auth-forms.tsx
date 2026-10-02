'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useForm, type FieldValues, type Path, type UseFormSetError } from 'react-hook-form';

import {
  forgotPasswordSchema,
  loginSchema,
  PASSWORD_MIN,
  resetPasswordSchema,
  signupSchema,
  type ForgotPasswordInput,
  type LoginInput,
  type ResetPasswordInput,
  type SignupInput,
} from '@shelf/shared';

import { Button } from '@/components/ui/button';
import { describedBy, Field, Input } from '@/components/ui/field';
import { api, API_BASE } from '@/lib/api-client';
import { ApiError, errorMessage } from '@/lib/api-error';
import { routes, safeNext } from '@/lib/routes';
import { useSession } from '@/lib/session';

/**
 * Puts the API's field errors under their fields and returns whatever is left
 * for the form-level message, so a server-side rejection reads the same as a
 * client-side one.
 */
function applyApiError<T extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<T>,
  fields: readonly Path<T>[],
): string | null {
  if (!(error instanceof ApiError)) return errorMessage(error);

  let placed = false;
  for (const detail of error.details) {
    const field = fields.find((name) => name === detail.field);
    if (field !== undefined) {
      setError(field, { message: detail.message });
      placed = true;
    }
  }
  return placed ? null : error.message;
}

function FormError({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <p role="alert" className="rounded-md border border-danger px-3 py-2 text-sm text-danger">
      {message}
    </p>
  );
}

export function AuthShell({
  title,
  intro,
  children,
  footer,
}: {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-5 py-12">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {intro !== undefined && <p className="text-sm text-text-muted">{intro}</p>}
      </div>
      {children}
      {footer !== undefined && <p className="text-sm text-text-muted">{footer}</p>}
    </main>
  );
}

const OAUTH_ERRORS: Record<string, string> = {
  oauth: 'Google sign-in did not complete. Try again.',
  oauth_unverified: 'Google has not verified that email address, so it cannot be used to sign in.',
};

function GoogleButton() {
  const { features } = useSession();
  if (!features.google) return null;
  return (
    <>
      <Button asChild className="w-full">
        {/* A full navigation, not a fetch: the API answers with a redirect to Google. */}
        <a href={`${API_BASE}/auth/oauth/google`}>Continue with Google</a>
      </Button>
      <div className="flex items-center gap-3 text-sm text-text-subtle">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>
    </>
  );
}

function useAfterAuth() {
  const router = useRouter();
  const { refresh } = useSession();
  const next = safeNext(useSearchParams().get('next'));
  return async () => {
    await refresh();
    router.push(next);
    router.refresh();
  };
}

export function SignInForm() {
  const params = useSearchParams();
  const done = useAfterAuth();
  const oauthError = OAUTH_ERRORS[params.get('error') ?? ''] ?? null;
  const [formError, setFormError] = useState<string | null>(oauthError);
  const { register, handleSubmit, setError, formState } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
  });
  const { errors, isSubmitting } = formState;

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await api('/auth/login', { method: 'POST', body: values });
      await done();
    } catch (error) {
      setFormError(applyApiError(error, setError, ['email', 'password']));
    }
  });

  return (
    <div className="flex flex-col gap-4">
      <GoogleButton />
      <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-4">
        <FormError message={formError} />
        <Field id="email" label="Email" error={errors.email?.message}>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            {...register('email')}
            {...describedBy('email', errors.email?.message)}
          />
        </Field>
        <Field id="password" label="Password" error={errors.password?.message}>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            {...register('password')}
            {...describedBy('password', errors.password?.message)}
          />
        </Field>
        <Button type="submit" variant="primary" disabled={isSubmitting}>
          {isSubmitting ? 'Signing in…' : 'Sign in'}
        </Button>
        <Link href={routes.forgotPassword} className="text-sm text-accent underline">
          Forgot your password?
        </Link>
      </form>
    </div>
  );
}

export function SignUpForm() {
  const done = useAfterAuth();
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState } = useForm<SignupInput>({
    resolver: zodResolver(signupSchema),
  });
  const { errors, isSubmitting } = formState;

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await api('/auth/signup', { method: 'POST', body: values });
      await done();
    } catch (error) {
      setFormError(applyApiError(error, setError, ['email', 'password', 'name']));
    }
  });

  return (
    <div className="flex flex-col gap-4">
      <GoogleButton />
      <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-4">
        <FormError message={formError} />
        <Field
          id="name"
          label="Name"
          hint="Shown on prompts you publish. Optional."
          error={errors.name?.message}
        >
          <Input
            id="name"
            autoComplete="name"
            {...register('name')}
            {...describedBy('name', errors.name?.message, true)}
          />
        </Field>
        <Field id="email" label="Email" error={errors.email?.message}>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            {...register('email')}
            {...describedBy('email', errors.email?.message)}
          />
        </Field>
        <Field
          id="password"
          label="Password"
          hint={`At least ${String(PASSWORD_MIN)} characters.`}
          error={errors.password?.message}
        >
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            {...register('password')}
            {...describedBy('password', errors.password?.message, true)}
          />
        </Field>
        <Button type="submit" variant="primary" disabled={isSubmitting}>
          {isSubmitting ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
    </div>
  );
}

export function ForgotPasswordForm() {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState } = useForm<ForgotPasswordInput>({
    resolver: zodResolver(forgotPasswordSchema),
  });
  const { errors, isSubmitting } = formState;

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await api('/auth/forgot-password', { method: 'POST', body: values });
      setSentTo(values.email);
    } catch (error) {
      setFormError(applyApiError(error, setError, ['email']));
    }
  });

  if (sentTo !== null) {
    return (
      <p role="status" className="rounded-md border border-border bg-surface-sunken p-4 text-sm">
        If an account exists for <strong>{sentTo}</strong>, a reset link is on its way. It expires
        in one hour.
      </p>
    );
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-4">
      <FormError message={formError} />
      <Field id="email" label="Email" error={errors.email?.message}>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          {...register('email')}
          {...describedBy('email', errors.email?.message)}
        />
      </Field>
      <Button type="submit" variant="primary" disabled={isSubmitting}>
        {isSubmitting ? 'Sending…' : 'Send reset link'}
      </Button>
    </form>
  );
}

export function ResetPasswordForm() {
  const token = useSearchParams().get('token') ?? '';
  const [done, setDone] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState } = useForm<ResetPasswordInput>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { token },
  });
  const { errors, isSubmitting } = formState;

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await api('/auth/reset-password', { method: 'POST', body: values });
      setDone(true);
    } catch (error) {
      setFormError(applyApiError(error, setError, ['password']));
    }
  });

  if (done) {
    return (
      <p role="status" className="rounded-md border border-border bg-surface-sunken p-4 text-sm">
        Your password is changed, and every other session was signed out.{' '}
        <Link href={routes.signIn()} className="text-accent underline">
          Sign in
        </Link>
      </p>
    );
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-4">
      <FormError message={formError ?? errors.token?.message ?? null} />
      <Field
        id="password"
        label="New password"
        hint={`At least ${String(PASSWORD_MIN)} characters.`}
        error={errors.password?.message}
      >
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          {...register('password')}
          {...describedBy('password', errors.password?.message, true)}
        />
      </Field>
      <Button type="submit" variant="primary" disabled={isSubmitting}>
        {isSubmitting ? 'Saving…' : 'Set new password'}
      </Button>
    </form>
  );
}

type VerifyState =
  { status: 'working' } | { status: 'done' } | { status: 'failed'; message: string };

export function VerifyEmail() {
  const token = useSearchParams().get('token');
  const { refresh } = useSession();
  const [state, setState] = useState<VerifyState>({ status: 'working' });
  // The token is single-use, and React runs effects twice in development.
  const started = useRef(false);

  useEffect(() => {
    if (started.current || token === null) return;
    started.current = true;

    api('/auth/verify-email', { method: 'POST', body: { token } })
      .then(async () => {
        await refresh();
        setState({ status: 'done' });
      })
      .catch((error: unknown) => {
        setState({ status: 'failed', message: errorMessage(error) });
      });
  }, [token, refresh]);

  if (token === null) return <FormError message="This link is missing its token." />;
  if (state.status === 'working') return <p role="status">Confirming your email…</p>;
  if (state.status === 'failed') return <FormError message={state.message} />;
  return (
    <p role="status" className="rounded-md border border-border bg-surface-sunken p-4 text-sm">
      Your email is confirmed. You can now publish to the public shelf.{' '}
      <Link href={routes.home} className="text-accent underline">
        Go to the library
      </Link>
    </p>
  );
}
