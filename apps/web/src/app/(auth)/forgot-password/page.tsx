import type { Metadata } from 'next';
import Link from 'next/link';

import { AuthShell, ForgotPasswordForm } from '@/components/auth-forms';
import { routes } from '@/lib/routes';

export const metadata: Metadata = { title: 'Reset password', robots: { index: false } };

export default function ForgotPasswordPage() {
  return (
    <AuthShell
      title="Reset your password"
      intro="Enter the email you signed up with and we will send a link to choose a new one."
      footer={
        <Link href={routes.signIn()} className="text-accent underline">
          Back to sign in
        </Link>
      }
    >
      <ForgotPasswordForm />
    </AuthShell>
  );
}
