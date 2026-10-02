import type { Metadata } from 'next';
import { Suspense } from 'react';

import { AuthShell, VerifyEmail } from '@/components/auth-forms';

export const metadata: Metadata = {
  title: 'Confirm your email',
  robots: { index: false },
  referrer: 'no-referrer',
};

export default function VerifyEmailPage() {
  return (
    <AuthShell title="Confirm your email">
      <Suspense>
        <VerifyEmail />
      </Suspense>
    </AuthShell>
  );
}
