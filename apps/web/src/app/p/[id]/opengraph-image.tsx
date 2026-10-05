import { ImageResponse } from 'next/og';
import { notFound } from 'next/navigation';

import { brand, palette } from '@shelf/config';
import { CATEGORY_LABELS, type Category, type PromptDetailDto } from '@shelf/shared';

import { serverApiOrNull } from '@/lib/api-server';

export const alt = `A prompt on ${brand.name}`;
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const colors = palette.light;

/**
 * Fetched with no cookies on purpose. A share image is served to crawlers and
 * cached by third parties, so it must only ever exist for what an anonymous
 * visitor can read; a private prompt 404s here even for its owner.
 */
export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await serverApiOrNull<{ prompt: PromptDetailDto }>(`/prompts/${id}`, {
    anonymous: true,
  });
  if (result === null) notFound();
  const { prompt } = result;

  const preview = prompt.body.replace(/\s+/g, ' ').trim().slice(0, 220);
  const author = prompt.author.kind === 'guest' ? brand.guestDisplayName : prompt.author.handle;

  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: 72,
        background: colors.surface,
        color: colors.text,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div style={{ display: 'flex', fontSize: 28, color: colors.textSubtle }}>
          {CATEGORY_LABELS[prompt.category as Category] ?? prompt.category}
        </div>
        <div style={{ display: 'flex', fontSize: 64, fontWeight: 700, lineHeight: 1.1 }}>
          {prompt.title.length > 80 ? `${prompt.title.slice(0, 79)}…` : prompt.title}
        </div>
        <div
          style={{
            display: 'flex',
            fontSize: 28,
            lineHeight: 1.45,
            color: colors.textMuted,
            background: colors.surfaceSunken,
            border: `2px solid ${colors.border}`,
            borderRadius: 12,
            padding: 28,
          }}
        >
          {preview.length === 220 ? `${preview}…` : preview}
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 30 }}>
        <div style={{ display: 'flex', color: colors.accent, fontWeight: 700 }}>
          {brand.shortName}
        </div>
        <div style={{ display: 'flex', color: colors.textMuted }}>by {author}</div>
      </div>
    </div>,
    size,
  );
}
