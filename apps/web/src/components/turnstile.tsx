'use client';

import Script from 'next/script';
import { useEffect, useRef, useState } from 'react';

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? '';

interface TurnstileApi {
  render: (
    element: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      'expired-callback': () => void;
      'error-callback': () => void;
    },
  ) => string;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

/** True when a real site key is configured and the API will demand a token. */
export const turnstileEnabled = SITE_KEY !== '';

/**
 * Cloudflare's bot check. Renders nothing with the local test key, where the
 * API skips verification too, so development needs no network access.
 */
export function Turnstile({ onToken }: { onToken: (token: string | null) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(() => typeof window !== 'undefined' && !!window.turnstile);
  const callback = useRef(onToken);
  useEffect(() => {
    callback.current = onToken;
  });

  useEffect(() => {
    if (!turnstileEnabled || !ready || host.current === null || window.turnstile === undefined) {
      return;
    }
    const api = window.turnstile;
    const widgetId = api.render(host.current, {
      sitekey: SITE_KEY,
      callback: (token) => callback.current(token),
      'expired-callback': () => callback.current(null),
      'error-callback': () => callback.current(null),
    });
    return () => api.remove(widgetId);
  }, [ready]);

  if (!turnstileEnabled) return null;
  return (
    <>
      <Script
        src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
        strategy="afterInteractive"
        onReady={() => setReady(true)}
      />
      <div ref={host} />
    </>
  );
}
