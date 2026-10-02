import type { Metadata } from 'next';
import { Suspense } from 'react';

import { AuthShell, ResetPasswordForm } from '@/components/auth-forms';

// The token is in the URL, so the page must not leak it through a Referer header.
export const metadata: Metadata = {
  title: 'Choose a new password',
  robots: { index: false },
  referrer: 'no-referrer',
};

export default function ResetPasswordPage() {
  return (
    <AuthShell title="Choose a new password">
      <Suspense>
        <ResetPasswordForm />
      </Suspense>
    </AuthShell>
  );
}
