import { parseTemplate } from '@shelf/shared';

import { cn } from '@/lib/utils';

/**
 * A prompt's source with its placeholders marked. Rendered from the same token
 * stream the editor uses, as text nodes, so nothing in a prompt body is ever
 * interpreted as markup.
 */
export function PromptBody({
  body,
  className,
  clamp = false,
}: {
  body: string;
  className?: string;
  /** Show only the opening lines, for a card. */
  clamp?: boolean;
}) {
  const { tokens } = parseTemplate(body);

  return (
    <pre
      className={cn(
        'rounded-md border border-border bg-surface-sunken p-3 font-mono text-[0.8125rem] leading-[1.3rem] break-words whitespace-pre-wrap',
        // Four whole lines: 4 x line-height, plus the padding and border. Cut at a
        // line boundary so a card never shows the top half of a fifth line.
        clamp && 'max-h-[calc(5.2rem+1.5rem+2px)] overflow-hidden',
        className,
      )}
    >
      <code>
        {tokens.map((token) =>
          token.kind === 'variable' ? (
            <span key={token.start} className="shelf-variable">
              {token.raw}
            </span>
          ) : (
            // The source slice rather than the unescaped value: this shows what
            // the author typed, escapes included.
            <span key={token.start}>{body.slice(token.start, token.end)}</span>
          ),
        )}
      </code>
    </pre>
  );
}
