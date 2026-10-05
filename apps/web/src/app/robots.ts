import type { MetadataRoute } from 'next';

const origin = process.env.NEXT_PUBLIC_WEB_ORIGIN ?? 'http://localhost:3000';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        // Signed-in surfaces and one-time links have nothing for a crawler.
        disallow: [
          '/shelf',
          '/settings',
          '/admin',
          '/new',
          '/sign-in',
          '/sign-up',
          '/reset-password',
          '/verify-email',
          '/api/',
        ],
      },
    ],
    sitemap: `${origin}/sitemap.xml`,
  };
}
