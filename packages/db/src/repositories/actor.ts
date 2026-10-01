import type { UserRole } from '@shelf/shared';

/**
 * Who is asking. Every repository read takes one of these; there is no way to
 * query prompts without stating an actor, which is what keeps the visibility
 * filter from being forgotten.
 */
export type Actor =
  | { type: 'user'; userId: string; role: UserRole }
  | { type: 'guest'; guestId: string }
  | { type: 'anonymous' };

export const ANONYMOUS: Actor = { type: 'anonymous' };

export const userActor = (userId: string, role: UserRole = 'user'): Actor => ({
  type: 'user',
  userId,
  role,
});

export const guestActor = (guestId: string): Actor => ({ type: 'guest', guestId });

export const isAdmin = (actor: Actor): boolean => actor.type === 'user' && actor.role === 'admin';
