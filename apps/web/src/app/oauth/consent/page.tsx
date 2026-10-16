import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import type { OAuthRequestDto } from '@shelf/shared';

import { AuthShell } from '@/components/auth-forms';
import { OAuthConsent } from '@/components/oauth-consent';
import { getMe, serverApiOrNull } from '@/lib/api-server';
import { routes } from '@/lib/routes';

export const metadata: Metadata = {
  title: 'Connect an app',
  robots: { index: false },
  referrer: 'no-referrer',
};

/** Why the authorize endpoint refused before it could send the app an answer. */
const ERRORS: Record<string, string> = {
  invalid_client:
    'Shelf does not recognise the app that sent you here. It may need to register again: remove Shelf from the app and add it back.',
  invalid_redirect_uri:
    'The app asked to be sent back to an address it never registered, so Shelf will not send anything there.',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function Stop({ title, message }: { title: string; message: string }) {
  return (
    <AuthShell
      title={title}
      footer={
        <>
          Setting up a client? See{' '}
          <Link href={routes.mcpDocs} className="text-accent underline">
            connecting MCP clients
          </Link>
          .
        </>
      }
    >
      <p role="alert" className="text-sm text-text-muted">
        {message}
      </p>
    </AuthShell>
  );
}

/**
 * Where an MCP client's sign-in lands: the API checked the client and its
 * redirect URI, stored the request, and sent the browser here to ask the user.
 */
export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const error = typeof params.error === 'string' ? params.error : undefined;
  const requestId = typeof params.request === 'string' ? params.request : undefined;

  if (error !== undefined) {
    return (
      <Stop
        title="This app cannot connect"
        message={ERRORS[error] ?? 'The app’s request could not be read. Start again from the app.'}
      />
    );
  }
  if (requestId === undefined || !UUID.test(requestId)) {
    return <Stop title="Nothing to approve" message="Start connecting from your MCP client." />;
  }

  const { user } = await getMe();
  if (user === null) redirect(routes.signIn(routes.oauthConsent(requestId)));

  const request = await serverApiOrNull<OAuthRequestDto>(`/oauth/requests/${requestId}`);
  if (request === null) {
    return (
      <Stop
        title="This request has ended"
        message="It expired or was already answered. Start connecting again from your app."
      />
    );
  }

  return (
    // The app's name is its own claim, so it is not the page's heading.
    <AuthShell title="Connect an app to your shelf">
      <OAuthConsent request={request} handle={user.handle} />
    </AuthShell>
  );
}
