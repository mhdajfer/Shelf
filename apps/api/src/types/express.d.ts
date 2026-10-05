import type { Actor } from '@shelf/db';
import type { SessionUser } from '@shelf/shared';

declare global {
  namespace Express {
    interface Request {
      /** Always set by the identity middleware; anonymous when nothing matched. */
      actor: Actor;
      user?: SessionUser;
      /** Hash of the session token, i.e. the sessions.id of the current session. */
      sessionId?: string;
      guestId?: string;
    }
  }
}

export {};
