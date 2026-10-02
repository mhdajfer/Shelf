import Markdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';

import { cn } from '@/lib/utils';

/**
 * Model output, rendered as Markdown. It is untrusted text: react-markdown
 * builds React elements rather than setting HTML, and rehype-sanitize strips
 * anything outside a conservative allowlist, so a response cannot inject script
 * or markup into the page.
 */
export function ModelOutput({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn('shelf-prose', className)}>
      <Markdown rehypePlugins={[rehypeSanitize]}>{text}</Markdown>
    </div>
  );
}
