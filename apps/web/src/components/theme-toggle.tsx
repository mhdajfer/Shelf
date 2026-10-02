'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useSyncExternalStore } from 'react';

import { Button } from '@/components/ui/button';

export const THEMES = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
] as const;

/** False during server rendering and hydration, true afterwards. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

/**
 * Cycles system, light, dark. The stylesheet already follows the system with
 * no JavaScript; this only records an explicit choice as `data-theme` on the
 * root, which is all the tokens need to switch.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const hydrated = useHydrated();

  // The stored choice is unknown on the server, so the first paint shows the
  // neutral option rather than guessing and then flipping.
  const index = hydrated
    ? Math.max(
        0,
        THEMES.findIndex((item) => item.value === theme),
      )
    : 0;
  const current = THEMES[index] ?? THEMES[0];
  const next = THEMES[(index + 1) % THEMES.length] ?? THEMES[0];
  const Icon = current.icon;

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setTheme(next.value)}
      aria-label={`Theme: ${current.label}. Switch to ${next.label}.`}
      title={`Theme: ${current.label}`}
    >
      <Icon />
    </Button>
  );
}
