import type { MetadataRoute } from 'next';

import { serverApi } from '@/lib/api-server';
import { routes } from '@/lib/routes';

const origin = process.env.NEXT_PUBLIC_WEB_ORIGIN ?? 'http://localhost:3000';

// Built on request: the list comes from the API and changes as prompts are published.
export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // The API endpoint returns public, active prompts only, and is asked
  // anonymously, so nothing private can be listed here.
  const { entries } = await serverApi<{ entries: { id: string; updatedAt: string }[] }>(
    '/sitemap',
    { anonymous: true },
  );

  return [
    { url: origin, changeFrequency: 'hourly', priority: 1 },
    ...entries.map((entry) => ({
      url: `${origin}${routes.prompt(entry.id)}`,
      lastModified: entry.updatedAt,
      changeFrequency: 'weekly' as const,
      priority: 0.7,
    })),
  ];
}
