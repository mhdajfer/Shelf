'use client';

import * as Menu from '@radix-ui/react-dropdown-menu';
import { Check } from 'lucide-react';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;

export function DropdownMenuContent({ className, ...props }: ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content
        sideOffset={6}
        align="end"
        className={cn(
          'z-50 min-w-44 rounded-md border border-border bg-surface-raised p-1 text-sm shadow-lg',
          className,
        )}
        {...props}
      />
    </Menu.Portal>
  );
}

export function DropdownMenuItem({ className, ...props }: ComponentProps<typeof Menu.Item>) {
  return (
    <Menu.Item
      className={cn(
        'flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 outline-none select-none data-highlighted:bg-surface-sunken [&_svg]:size-4 [&_svg]:text-text-subtle',
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof Menu.Label>) {
  return <Menu.Label className={cn('px-2 py-1.5 text-text-subtle', className)} {...props} />;
}

export function DropdownMenuSeparator() {
  return <Menu.Separator className="my-1 h-px bg-border" />;
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: ComponentProps<typeof Menu.CheckboxItem>) {
  return (
    <Menu.CheckboxItem
      className={cn(
        'relative flex cursor-default items-center rounded-sm py-1.5 pr-2 pl-7 outline-none select-none data-highlighted:bg-surface-sunken',
        className,
      )}
      {...props}
    >
      <span className="absolute left-2 inline-flex size-4 items-center justify-center">
        <Menu.ItemIndicator>
          <Check className="size-4" />
        </Menu.ItemIndicator>
      </span>
      {children}
    </Menu.CheckboxItem>
  );
}
