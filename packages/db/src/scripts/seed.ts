import { randomUUID } from 'node:crypto';

import { extractVariables, trendingScore } from '@shelf/shared';

import { createDatabase, type Database } from '../client.js';
import { createPool } from '../pool.js';
import { promptRepo } from '../repositories/promptRepo.js';
import { collections } from '../schema/collections.js';
import { prompts } from '../schema/prompts.js';
import { users } from '../schema/users.js';
import { collectionRepo } from '../repositories/collectionRepo.js';
import { DATABASE_URL, REQUIRES_TLS } from './env.js';
import { SEED_AUTHORS, SEED_GUEST_PROMPTS, SEED_PROMPTS, type SeedPrompt } from './seed-data.js';
import { eq, sql } from 'drizzle-orm';

if (process.env.NODE_ENV === 'production') {
  throw new Error('Refusing to seed a production database.');
}

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS ?? '')
  .split(',')
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

/**
 * Deterministic so a reseed produces the same shelf. Demo data should not
 * reshuffle every time someone runs the script.
 */
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

const random = makeRandom(20_260_401);

const HOUR = 3_600_000;

async function truncateAll(db: Database): Promise<void> {
  const rows = await db.execute<{ tablename: string }>(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  const list = rows.rows.map((row) => `"${row.tablename}"`).join(', ');
  if (list !== '') {
    await db.execute(sql.raw(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`));
  }
}

async function seedAuthors(db: Database): Promise<{ id: string; handle: string }[]> {
  const rows = await db
    .insert(users)
    .values(
      SEED_AUTHORS.map((author) => ({
        email: author.email,
        handle: author.handle,
        name: author.name,
        emailVerifiedAt: new Date(),
        role: ADMIN_EMAILS.includes(author.email) ? ('admin' as const) : ('user' as const),
      })),
    )
    .returning({ id: users.id, handle: users.handle });

  // Admins are configured by email, so seed any that are not already authors.
  const extraAdmins = ADMIN_EMAILS.filter(
    (email) => !SEED_AUTHORS.some((author) => author.email === email),
  );
  if (extraAdmins.length > 0) {
    await db
      .insert(users)
      .values(
        extraAdmins.map((email, index) => ({
          email,
          handle: `admin${String(index + 1)}`,
          name: 'Admin',
          role: 'admin' as const,
          emailVerifiedAt: new Date(),
        })),
      )
      .onConflictDoNothing();
  }

  return rows;
}

async function insertSeedPrompt(
  db: Database,
  prompt: SeedPrompt,
  author:
    { type: 'user'; userId: string } | { type: 'guest'; guestId: string; guestHandle: string },
  ageHours: number,
): Promise<string> {
  const id = await promptRepo.create(db, {
    author,
    visibility: 'public',
    title: prompt.title,
    description: prompt.description,
    category: prompt.category,
    modelHint: prompt.modelHint,
    body: prompt.body,
    variables: extractVariables(prompt.body),
    tags: prompt.tags,
  });

  const createdAt = new Date(Date.now() - ageHours * HOUR);
  const upvotes = Math.floor(random() * 90);
  const forks = Math.floor(random() * 12);

  await db
    .update(prompts)
    .set({
      createdAt,
      updatedAt: createdAt,
      upvoteCount: upvotes,
      forkCount: forks,
      trendingScore: trendingScore({ upvotes, forks, createdAt }),
    })
    .where(eq(prompts.id, id));

  return id;
}

async function main(): Promise<void> {
  const pool = createPool({ connectionString: DATABASE_URL, ssl: REQUIRES_TLS, max: 4 });
  const db = createDatabase(pool);

  try {
    await truncateAll(db);
    const authors = await seedAuthors(db);

    const publicIds: string[] = [];
    for (const [index, prompt] of SEED_PROMPTS.entries()) {
      const author = authors[index % authors.length];
      if (author === undefined) throw new Error('no seed authors');
      publicIds.push(
        await insertSeedPrompt(
          db,
          prompt,
          { type: 'user', userId: author.id },
          Math.floor(random() * 600) + 1,
        ),
      );
    }

    for (const prompt of SEED_GUEST_PROMPTS) {
      const guestId = randomUUID();
      await insertSeedPrompt(
        db,
        prompt,
        { type: 'guest', guestId, guestHandle: `guest-${guestId.slice(0, 4)}` },
        Math.floor(random() * 48) + 1,
      );
    }

    // A few forks, so lineage and the "Forked from" link have something to show.
    const firstAuthor = authors[0];
    if (firstAuthor !== undefined) {
      for (const sourceId of publicIds.slice(0, 4)) {
        const source = await promptRepo.findVisible(db, { type: 'anonymous' }, sourceId);
        if (source === null) continue;
        await promptRepo.create(db, {
          author: { type: 'user', userId: firstAuthor.id },
          visibility: 'public',
          title: `${source.title} (shorter)`,
          description: source.description,
          category: source.category as SeedPrompt['category'],
          modelHint: source.modelHint,
          body: source.body,
          variables: source.variables,
          tags: source.tags,
          forkedFromId: sourceId,
        });
      }
    }

    // One author keeps a private shelf, so the signed-in views are not empty and
    // the privacy rules have something real to hide.
    const shelfOwner = authors[1];
    if (shelfOwner !== undefined) {
      const privateIds: string[] = [];
      for (const prompt of SEED_PROMPTS.slice(0, 5)) {
        privateIds.push(
          await promptRepo.create(db, {
            author: { type: 'user', userId: shelfOwner.id },
            visibility: 'private',
            title: `${prompt.title} (mine)`,
            description: prompt.description,
            category: prompt.category,
            modelHint: prompt.modelHint,
            body: prompt.body,
            variables: extractVariables(prompt.body),
            tags: prompt.tags,
          }),
        );
      }

      const collectionId = await collectionRepo.createCollection(db, shelfOwner.id, 'Drafts');
      for (const id of privateIds.slice(0, 3)) {
        await collectionRepo.addItem(db, shelfOwner.id, collectionId, id);
      }

      // A second version, so version history and diff are not empty on day one.
      const first = privateIds[0];
      if (first !== undefined) {
        await promptRepo.addVersion(db, first, {
          body: `${SEED_PROMPTS[0]?.body ?? ''}\n\nKeep the result under 120 words.`,
          variables: extractVariables(SEED_PROMPTS[0]?.body ?? ''),
          note: 'Add a length ceiling',
        });
      }

      await db
        .update(prompts)
        .set({ pinnedAt: new Date() })
        .where(eq(prompts.id, privateIds[0] ?? ''));
    }

    const counts = await db.execute<{ visibility: string; count: number }>(
      sql`SELECT visibility::text, count(*)::int AS count FROM prompts GROUP BY visibility ORDER BY visibility`,
    );
    const collectionCount = await db.$count(collections);

    console.log('seeded:');
    for (const row of counts.rows) {
      console.log(`  ${row.visibility}: ${String(row.count)} prompts`);
    }
    console.log(`  users: ${String(authors.length)}`);
    console.log(`  collections: ${String(collectionCount)}`);
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  console.error('seed failed');
  console.error(error);
  process.exitCode = 1;
}
