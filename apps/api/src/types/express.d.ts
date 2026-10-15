import type { AuthInfo } from '@modelcontextprotocol/server';

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
      /** Set on MCP requests by the bearer middleware; the SDK reads it from here. */
      auth?: AuthInfo;
    }
  }
}

export {};
