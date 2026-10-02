import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';

import { AuthShell, SignUpForm } from '@/components/auth-forms';
import { routes } from '@/lib/routes';

export const metadata: Metadata = { title: 'Create account', robots: { index: false } };

export default function SignUpPage() {
  return (
    <AuthShell
      title="Create your account"
      intro="A private shelf for your prompts, with version history and test runs."
      footer={
        <>
          Already have an account?{' '}
          <Link href={routes.signIn()} className="text-accent underline">
            Sign in
          </Link>
        </>
      }
    >
      <Suspense>
        <SignUpForm />
      </Suspense>
    </AuthShell>
  );
}
