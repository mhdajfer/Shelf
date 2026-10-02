import type { Metadata, Viewport } from 'next';
import { GeistSans } from 'geist/font/sans';

import { brand } from '@shelf/config';

import { CommandCenter } from '@/components/command-center';
import { Providers } from '@/components/providers';
import { SiteHeader } from '@/components/site-header';
import { getMe } from '@/lib/api-server';

import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_WEB_ORIGIN ?? 'http://localhost:3000'),
  title: { default: brand.name, template: `%s · ${brand.name}` },
  description: brand.description,
  applicationName: brand.name,
  openGraph: { siteName: brand.name, type: 'website' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'light dark',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const me = await getMe();

  return (
    <html lang="en" className={GeistSans.variable} suppressHydrationWarning>
      <body className="flex min-h-dvh flex-col">
        <a
          href="#content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-surface-raised focus:px-3 focus:py-2"
        >
          Skip to content
        </a>
        <Providers me={me}>
          <SiteHeader />
          <CommandCenter />
          <div id="content" className="flex flex-1 flex-col">
            {children}
          </div>
          <footer className="border-t border-border">
            <p className="mx-auto max-w-5xl px-5 py-6 text-sm text-text-subtle">
              <span className="font-mono text-text-muted">{brand.name}</span> · {brand.tagline}
            </p>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
