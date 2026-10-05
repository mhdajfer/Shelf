import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';

import { AuthShell, SignInForm } from '@/components/auth-forms';
import { routes } from '@/lib/routes';

export const metadata: Metadata = { title: 'Sign in', robots: { index: false } };

export default function SignInPage() {
  return (
    <AuthShell
      title="Sign in"
      footer={
        <>
          New here?{' '}
          <Link href={routes.signUp} className="text-accent underline">
            Create an account
          </Link>
        </>
      }
    >
      <Suspense>
        <SignInForm />
      </Suspense>
    </AuthShell>
  );
}
