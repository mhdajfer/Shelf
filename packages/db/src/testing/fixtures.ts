import { randomUUID } from 'node:crypto';

import { type Category, type UserRole, type Visibility, extractVariables } from '@shelf/shared';

import type { Database } from '../client.js';
import { promptRepo } from '../repositories/promptRepo.js';
import { users } from '../schema/users.js';

let counter = 0;
const unique = (prefix: string): string =>
  `${prefix}-${String(++counter)}-${randomUUID().slice(0, 8)}`;

export interface UserFixture {
  id: string;
  email: string;
  handle: string;
  role: UserRole;
}

export async function makeUser(
  db: Database,
  overrides: Partial<{ email: string; handle: string; name: string; role: UserRole }> = {},
): Promise<UserFixture> {
  const handle = overrides.handle ?? unique('user');
  const email = overrides.email ?? `${handle}@example.test`;
  const role = overrides.role ?? 'user';

  const [row] = await db
    .insert(users)
    .values({
      email,
      handle,
      name: overrides.name ?? handle,
      role,
      emailVerifiedAt: new Date(),
    })
    .returning({ id: users.id });

  if (row === undefined) throw new Error('user fixture insert returned no row');
  return { id: row.id, email, handle, role };
}

export interface PromptFixtureInput {
  title?: string;
  body?: string;
  description?: string;
  category?: Category;
  modelHint?: string;
  tags?: string[];
  forkedFromId?: string;
}

/** A private prompt owned by `userId`. */
export function makeUserPrompt(
  db: Database,
  userId: string,
  input: PromptFixtureInput & { visibility?: Visibility } = {},
): Promise<string> {
  const body = input.body ?? 'Summarize {{source}} for a {{audience:general}} reader.';
  return promptRepo.create(db, {
    author: { type: 'user', userId },
    visibility: input.visibility ?? 'private',
    title: input.title ?? unique('Prompt'),
    description: input.description ?? null,
    category: input.category ?? 'writing',
    modelHint: input.modelHint ?? null,
    body,
    variables: extractVariables(body),
    tags: input.tags ?? [],
    forkedFromId: input.forkedFromId ?? null,
  });
}

/** Guest prompts are always public; the schema enforces it. */
export function makeGuestPrompt(
  db: Database,
  guestId: string,
  input: PromptFixtureInput = {},
): Promise<string> {
  const body = input.body ?? 'Draft a changelog entry for {{change}}.';
  return promptRepo.create(db, {
    author: { type: 'guest', guestId, guestHandle: `guest-${guestId.slice(0, 4)}` },
    visibility: 'public',
    title: input.title ?? unique('Guest prompt'),
    description: input.description ?? null,
    category: input.category ?? 'writing',
    modelHint: input.modelHint ?? null,
    body,
    variables: extractVariables(body),
    tags: input.tags ?? [],
  });
}
