'use client';

import { LogOut, User } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { brand } from '@shelf/config';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/api-error';
import { routes } from '@/lib/routes';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';

function NavLink({
  href,
  exact = false,
  children,
}: {
  href: string;
  exact?: boolean;
  children: string;
}) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname.startsWith(href);
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'rounded-md px-2.5 py-1.5 text-sm text-text-muted transition-colors duration-fast ease-shelf hover:text-text',
        active && 'bg-surface-sunken text-text',
      )}
    >
      {children}
    </Link>
  );
}

function VerifyBanner() {
  const [sent, setSent] = useState(false);

  async function resend() {
    try {
      await api('/auth/resend-verification', { method: 'POST' });
      setSent(true);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <div className="border-b border-border bg-surface-sunken">
      <p className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2 text-sm text-text-muted">
        Confirm your email address to publish prompts to the public shelf.
        {sent ? (
          <span className="text-success">Sent. Check your inbox.</span>
        ) : (
          <button type="button" onClick={() => void resend()} className="text-accent underline">
            Resend the email
          </button>
        )}
      </p>
    </div>
  );
}

export function SiteHeader() {
  const { user, refresh } = useSession();
  const router = useRouter();

  async function signOut() {
    try {
      await api('/auth/logout', { method: 'POST' });
      await refresh();
      router.push(routes.home);
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <>
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-5">
          <Link href={routes.home} className="font-mono text-lg tracking-tight">
            {brand.name}
          </Link>
          <nav aria-label="Main" className="flex items-center gap-1">
            <NavLink href={routes.home} exact>
              Library
            </NavLink>
          </nav>

          <div className="ml-auto flex items-center gap-2">
            {user === null ? (
              <>
                <Button asChild variant="ghost" size="sm">
                  <Link href={routes.signIn()}>Sign in</Link>
                </Button>
                <Button asChild variant="primary" size="sm">
                  <Link href={routes.signUp}>Create account</Link>
                </Button>
              </>
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="secondary" size="sm" aria-label="Account menu">
                    <span className="font-mono">{user.handle}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuLabel>{user.email}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link href={routes.profile(user.handle)}>
                      <User />
                      Public profile
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void signOut()}>
                    <LogOut />
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      </header>
      {user !== null && !user.emailVerified && <VerifyBanner />}
    </>
  );
}
