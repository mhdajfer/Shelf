'use client';

import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button, type ButtonProps } from '@/components/ui/button';

export function CopyButton({
  text,
  label = 'Copy',
  ...props
}: { text: string | (() => string); label?: string } & Omit<ButtonProps, 'onClick'>) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(typeof text === 'function' ? text() : text);
      setCopied(true);
    } catch {
      toast.error('Your browser blocked the copy. Select the text and copy it manually.');
    }
  }

  return (
    <Button onClick={() => void copy()} {...props}>
      {copied ? <Check /> : <Copy />}
      {/* The live region announces the change; the visible label swaps with it. */}
      <span aria-live="polite">{copied ? 'Copied' : label}</span>
    </Button>
  );
}
