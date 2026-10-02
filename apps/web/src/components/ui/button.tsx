import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes, Ref } from 'react';

import { cn } from '@/lib/utils';

export const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors duration-fast ease-shelf select-none disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-accent-contrast hover:bg-accent-hover',
        secondary:
          'border border-border-strong bg-surface-raised text-text hover:bg-surface-sunken',
        ghost: 'text-text-muted hover:bg-surface-sunken hover:text-text',
        danger: 'border border-border-strong bg-surface-raised text-danger hover:bg-surface-sunken',
      },
      size: {
        sm: 'h-8 px-2.5 text-sm',
        md: 'h-9 px-3.5 text-sm',
        icon: 'size-8',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Render the child (a link, usually) with button styling instead of a <button>. */
  asChild?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Component = asChild ? Slot : 'button';
  return (
    <Component
      {...(asChild ? {} : { type: props.type ?? 'button' })}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
