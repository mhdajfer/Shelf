# Shelf

A library for prompts you reuse. Write them, version them, test them, and keep the ones that work.

Two faces, one codebase:

- **The public shelf** — a browsable, searchable library anyone can read, copy, upvote, and fork.
  Guests can contribute with a small daily credit allowance.
- **Your shelf** — for signed-in users. Private by default, with collections, version history,
  variables, test runs, and version comparison.

> Build status: phase 8 of 9 complete. Everything in the product is built; what remains is the
> end-to-end test pass, the accessibility and security review, and deploy configuration, per the
> [Roadmap](#roadmap).

## Why

Most prompt "managers" are either a notes app with syntax highlighting or a chat window with a save
button. Neither treats a prompt as what it is: a small program with inputs, revisions, and a test
suite. Shelf treats the prompt body as source, `{{variables}}` as its signature, every save as a
commit, and a model call as a test run.

## Architecture

```mermaid
flowchart LR
  subgraph Browser
    UI["Next.js App Router<br/>RSC + TanStack Query"]
  end

  subgraph "Vercel"
    WEB["@shelf/web<br/>SSR, OG images, sitemap"]
  end

  subgraph "Render / Railway"
    API["@shelf/api<br/>Express, REST + SSE"]
  end

  PG[("Postgres<br/>Neon")]
  RD[("Redis<br/>Upstash")]
  GEM["Gemini API"]
  MAIL["Resend"]

  UI -->|"document requests"| WEB
  UI -->|"/api/v1/*, credentialed"| API
  WEB -->|"server-side reads"| API
  API --> PG
  API --> RD
  API --> GEM
  API --> MAIL
```

```
shelf/
  apps/
    web/          Next.js App Router, Tailwind v4, CodeMirror 6
    api/          Express, REST + SSE, owns every secret
  packages/
    shared/       template parser, scoring, DTO schemas, constants
    db/           Drizzle schema, migrations, seed, repositories, test harness
    config/       tsconfig / ESLint / Prettier / Tailwind theme / brand
  docker-compose.yml
  .github/workflows/ci.yml
```

### Why a separate Express service

Next.js route handlers could serve this API. Express is a deliberate choice, with a real cost:

- **Secret isolation.** The Gemini key, session secret, and credit ledger live in one process that
  has no rendering responsibilities and no client bundle.
- **Long-lived SSE.** Streaming a test run can outlast a serverless invocation budget. A persistent
  Node process does not have that ceiling.
- **A second consumer.** A CLI or browser extension can use the same REST surface without going
  through a rendering layer.

The cost: two deploy targets, two cold starts, and CORS plus cookie scoping to get right. For a
single-surface product this would be over-engineering; it is justified here by the streaming and
secret-isolation requirements.

### Cookies across two origins

In production the browser calls the API origin directly (`api.<domain>`) rather than through a
Next.js rewrite. Rewriting `/api/*` through the web host would be simpler, but it would reintroduce
the platform proxy response timeout on exactly the SSE streams the separate service exists to
support. Instead:

- the session cookie is scoped to the parent domain, so both origins send it;
- `SameSite=Lax` still holds, because sibling subdomains are same-site;
- CORS uses an explicit origin allowlist with `credentials: true`;
- state-changing routes additionally require a double-submit CSRF token.

In development there is no proxy in front of the API, so `next.config.ts` rewrites `/api/*` to
`localhost:4000` and the cookie stays host-only. Nothing in application code branches on this.

## Prompt templates

The template grammar is the one piece of logic both apps depend on, so it lives in
`@shelf/shared` with no dependencies.

```
variable := "{{" name [ ":" default ] "}}"
name     := [A-Za-z_][A-Za-z0-9_-]*      case sensitive, max 64 chars
default  := text up to the first "}}"    surrounding whitespace trimmed
escape   := "\{{" -> "{{"   "\}}" -> "}}"   "\\" -> "\"
```

Decisions worth knowing:

- **Only the first colon splits**, so `{{url:https://example.com:8080/path}}` has the default you
  would expect.
- **Defaults are per variable, not per occurrence.** `{{tone}} … {{tone:direct}}` declares one
  variable defaulting to `direct`; both occurrences render it. A second, different default is
  ignored and reported.
- **A supplied empty string is a value** and overrides the default. Only `undefined` counts as
  unsupplied, so clearing a prefilled field clears the output.
- **Nothing is ever dropped.** Malformed tags stay in the body verbatim and surface as diagnostics
  the editor can underline. Concatenating every token's source range reproduces the input exactly,
  which is asserted as a property over a battery of inputs.

`parseTemplate` returns tokens with source offsets, which is what the CodeMirror highlighter and the
preview renderer both consume — one parser, not two.

## Data model

```mermaid
erDiagram
  users ||--o{ prompts : owns
  users ||--o{ oauth_accounts : ""
  users ||--o{ sessions : ""
  users ||--o{ email_tokens : ""
  users ||--o{ collections : ""
  prompts ||--|{ prompt_versions : "history"
  prompts }o--o{ tags : "prompt_tags"
  prompts ||--o{ votes : ""
  prompts ||--o{ reports : ""
  prompts }o--|| prompts : "forked_from"
  collections ||--o{ collection_items : ""
  collection_items }o--|| prompts : ""
  prompt_versions ||--o{ runs : ""

  prompts {
    uuid id PK
    uuid owner_id FK "null for guest prompts"
    text guest_id "null for user prompts"
    text guest_handle "guest-7fk2"
    enum visibility "public | private"
    enum status "active | hidden | deleted"
    uuid current_version_id FK
    uuid forked_from_id FK
    int upvote_count
    int fork_count
    real trending_score
    tsvector search_vector
  }
  prompt_versions {
    uuid id PK
    int number "unique per prompt"
    text body
    jsonb variables
    text note
  }
  credit_ledger {
    bigserial id PK
    enum actor_type "user | guest"
    text actor_id
    text ip_hash "second allowance for guests"
    enum kind "create | run | tool | refund"
    int amount "negative debits"
    bigint ref_id "debit a refund reverses"
  }
```

### What the database enforces itself

Four invariants are too important to leave to application code, so they live in Postgres and are
asserted against a real engine in `packages/db/src/schema.spec.ts`:

- **A prompt has exactly one author.** `(owner_id IS NULL) <> (guest_id IS NULL)`, plus
  `guest_id IS NULL OR visibility = 'public'` — a guest has no shelf, so guest content cannot be
  private.
- **Versions are immutable.** A trigger rejects `UPDATE` on `prompt_versions`; a rewritten version
  would make every diff built on it a lie. `DELETE` stays permitted so cascading a prompt delete
  still works.
- **The credit ledger is append-only.** Triggers reject `UPDATE` and `DELETE`. A failed model call is
  corrected with a compensating `refund` row, so the attempt stays auditable and a balance is always
  a sum.
- **One vote and one report per actor.** Two *partial* unique indexes per table, one for `user_id`
  and one for `guest_id`. A single index spanning both nullable columns would let the same voter
  insert repeatedly, because NULLs never collide — which would also let one person trip the
  three-report auto-hide alone.

`search_vector` is maintained by trigger rather than being a generated column: the weighting spans
`prompts.title` (A), the `prompt_tags` join (B), `prompts.description` (C), and the body of the
*current version* (D), and a generated column can only see its own row. The whole weighting lives in
one SQL function so the three triggers that call it cannot disagree.

## Privacy enforcement

`readableBy(actor)` in `packages/db/src/repositories/promptRepo.ts` is the only place visibility is
decided. Every read composes it, and `@shelf/db` deliberately does not export the table definitions
— they sit behind `@shelf/db/schema`, which an ESLint rule forbids `apps/api` from importing. A route
cannot skip the filter because a route cannot reach the table.

The rules:

| Actor         | Can read                                                        |
| ------------- | --------------------------------------------------------------- |
| anyone        | public + active                                                 |
| owner         | their own, any visibility, any status except deleted            |
| guest         | their own guest prompts (matched on the guest cookie id)        |
| admin         | the above, plus public prompts that moderation has **hidden**   |

Admin is not a master key. Moderation covers public content, so the admin clause widens access to
hidden *public* prompts and nothing else; `privacy.spec.ts` asserts an admin cannot read a private
prompt.

Reads return `null` rather than throwing, so the route answers **404, not 403**, for another actor's
prompt. 403 would confirm it exists.

## Prompt API

Every route lives under `/api/v1`. Reads take the actor from the session or guest cookie and go
through `readableBy`; writes first establish ownership with `promptRepo.findOwned`.

| Method and path                                  | What it does                                               |
| ------------------------------------------------ | ---------------------------------------------------------- |
| `GET /prompts`                                   | Public listing: `sort`, `category`, `tag`, `model`, `q`    |
| `POST /prompts`                                  | Create. Private by default for users, public for guests    |
| `GET /prompts/:id`                               | One prompt, with what it is to the viewer                  |
| `PATCH /prompts/:id`                             | Edit. A changed body saves a new version                   |
| `DELETE /prompts/:id`                            | Soft delete                                                |
| `GET /prompts/:id/versions[/:versionId]`         | History                                                    |
| `GET /prompts/:id/diff?from=&to=`                | Line diff; defaults to current against previous            |
| `POST /prompts/:id/versions/:versionId/restore`  | Appends the old body as a new version                      |
| `POST /prompts/:id/fork`                         | Copy onto your shelf, with lineage                         |
| `PUT` / `DELETE /prompts/:id/vote`               | Upvote, idempotent per voter                               |
| `POST /prompts/:id/report`                       | Report; three different reporters hide the prompt          |
| `GET /shelf/prompts`                             | The signed-in user's own prompts                           |
| `GET /credits`                                   | Today's remaining allowance                                |
| `GET /shelf/summary`                             | Sidebar counts and collections                             |
| `POST` / `PATCH` / `DELETE /collections[/:id]`   | Manage collections; `PUT /collections/order` reorders      |
| `PUT` / `DELETE /collections/:id/prompts/:promptId` | File a prompt, only when you own both                   |

Status codes carry meaning: **404** for a prompt you cannot read (whether or not it exists),
**403** for a public prompt you can read but do not own, **402** when the day's credits are spent,
**429** when a rate limit trips.

**Credits** are a check-and-debit under a per-actor Postgres advisory lock, so requests racing for
the last credit cannot both win. A guest is metered by cookie *and* by hashed address, taking
whichever count is higher. Signed-in users are not metered on creation, only on model calls.

**`updated_at` means "the author changed this".** Migration `0002` narrows the trigger to authored
columns, so an upvote, a pin, or a trending recompute no longer reshuffles the owner's shelf.

## Model calls

Everything model-backed goes through one interface, `LlmProvider`, with two implementations:
`GeminiProvider` when `GEMINI_API_KEY` is set and `FakeProvider` when it is not. The fake streams
word by word, takes time, honours cancellation, and reports token counts, so credits, refunds, SSE,
and the UI are all exercised with no key and no network. The integration tests use it too.

| Endpoint               | What it does                                                             |
| ---------------------- | ------------------------------------------------------------------------ |
| `POST /runs`           | Renders a version with its inputs, streams the answer as server-sent events |
| `GET /prompts/:id/runs` | Your own earlier runs of a prompt                                       |
| `POST /tools/tighten`  | Proposes a shorter rewrite; reports any `{{placeholder}}` it lost        |
| `POST /tools/suggest`  | Returns up to five structured suggestions                                |

A run is admitted in the order that costs least: rate limit, then the global daily ceiling, then the
actor's own credit, which is debited before the call. Everything that can refuse happens **before
the first byte**, so a refusal is ordinary JSON with a real status code (402, 404, 429, 503); once
the stream is open, failure is an `error` event. A timeout or provider failure **refunds** the credit
with a compensating ledger row. A run the user stops is not refunded, since the model was called and
otherwise "start, read, stop" would be free.

Runs are private to whoever made them. A run stores what its author typed into the variables, so
not even the prompt's owner can list someone else's runs of it.

`POST /runs` is a POST with a body and a CSRF header, which `EventSource` cannot send, so the web
client reads the stream from `fetch` and parses the event framing itself (`lib/run-stream.ts`).
Model output is rendered as Markdown through `react-markdown` with `rehype-sanitize`; an ESLint
rule forbids `dangerouslySetInnerHTML` across the web app.

**Comparing versions** runs two versions on the same inputs side by side, on the history page under
the diff: the diff shows what changed in the prompt, the comparison shows what the change did to the
answer.

## Search and ranking

Search is Postgres full-text over the trigger-maintained `search_vector`, queried with
`websearch_to_tsquery`, so quoted phrases and `-exclusions` work and stray punctuation cannot raise.
Results rank by `ts_rank_cd`, which respects the A-D weighting (title, tags, description, body).

Trending is `(upvotes + 2 x forks) / (age_hours + 2)^1.5`. The score is stored, because a decay
formula in `ORDER BY` cannot use an index, and recomputed for the whole public shelf in one `UPDATE`
every 15 minutes by an in-process cron job and once at boot. `library.spec.ts` asserts the SQL
agrees with `trendingScore()` in `@shelf/shared`; both read the same constants. For hosts that sleep,
`POST /api/v1/cron/trending` with `Authorization: Bearer $CRON_SECRET` does the same on demand.

## The web app

Public pages are server-rendered by fetching the API with the visitor's cookies forwarded, so the
API resolves the same actor it would for a browser request and there is one place that decides what
anyone may see. The library keeps its state in the URL: every filter, sort, and page is a plain
link that works without JavaScript.

| Route                 | What it is                                                         |
| --------------------- | ------------------------------------------------------------------ |
| `/`                   | The public shelf: search, category and tag filters, four sorts     |
| `/p/[id]`             | A prompt: source, a fill-in-the-variables panel, vote, fork, report |
| `/p/[id]/opengraph-image` | Share image, rendered with `next/og` from the shared palette   |
| `/u/[handle]`         | A public profile                                                   |
| `/sign-in`, `/sign-up`, `/forgot-password`, `/reset-password`, `/verify-email` | Account flows |
| `/sitemap.xml`, `/robots.txt` | Public, active prompts only                                |

| `/shelf`              | Your prompts: all, pinned, by collection, and searchable           |
| `/new`, `/p/[id]/edit` | The editor. Works for guests too, on the daily allowance          |
| `/p/[id]/history`     | Every version, with a line diff and restore                        |

| `/settings`           | Profile, password, export and import, delete account               |
| `/admin`              | The moderation queue. A 404 for anyone who is not an admin         |

**The command palette** (`Ctrl/Cmd+K`) searches your shelf and the public shelf and runs every
navigation and theme command. Single-key shortcuts cover the rest: `/` focuses search, `N` starts a
prompt, `G` then `L` or `S` goes to the library or your shelf, `?` lists them all. They are ignored
while you are typing in a field.

**Theme.** The stylesheet already follows the system preference with no JavaScript. The toggle
records an explicit choice as `data-theme` on the root, which is all the `light-dark()` tokens need.

**Export and import.** `GET /export` returns one JSON file with every prompt you own, its full
version history, tags, pins, and collections. `POST /import` reads the same format; each entry is
validated on its own, so a malformed one is skipped and reported instead of failing the file.
Imported prompts always arrive **private**, whatever the file says: publishing is a decision made
per prompt, with the checks that go with it. Any readable prompt also downloads as Markdown from
`GET /prompts/:id/export`, fenced with more backticks than the body contains.

**Moderation.** `/admin` lists public prompts with open reports and offers two actions: restore to
the shelf, or remove. The queue is built from reports, and only public prompts can be reported, so
it has no path to private content; `transfer.spec.ts` asserts an admin cannot resolve a report
against a private prompt.

**Deleting an account** needs the password (or, for a Google-only account, typing the handle) and
cascades to every prompt, version, collection, and session the account owned.

**The editor** is CodeMirror 6 with one extension that calls `parseTemplate` from `@shelf/shared`:
placeholders are marked, malformed ones get a wavy underline and a message under the editor, and
typing `{{` offers the variables the prompt already uses. The variables list and the live preview
beside it read the same parse, so the editor, the preview, and the API cannot disagree about what a
variable is. `Ctrl/Cmd+S` saves; a save that changes the body asks what changed and stores the
answer with the new version.

**Collections** reorder by drag and drop (dnd-kit), including from the keyboard: focus a handle,
`Space` to lift, arrows to move. Shelf state lives in the URL, so a filtered view can be bookmarked.

The share image and the sitemap fetch **anonymously**, never with the visitor's cookies: both are
cached by third parties, so they may only ever contain what a signed-out visitor can read.

## Authentication

Sessions are opaque random tokens in an `HttpOnly`, `SameSite=Lax` cookie. The database stores only
the SHA-256 of each token, so a dump of `sessions` cannot be replayed. The same is true of emailed
verification and reset tokens, which are single-use and consumed in one `UPDATE … RETURNING`.

- **Passwords** are argon2id. A login for an unknown address still runs a verify against a throwaway
  hash, and "wrong password", "no such account" and "Google-only account" share one message.
- **CSRF** is a signed double-submit token: `GET /api/v1/auth/me` returns it, and every
  state-changing request must echo it in `x-csrf-token`. The signature stops a sibling subdomain
  from planting a matching pair.
- **Admin is earned, not claimed.** An address in `ADMIN_EMAILS` gets the role when it is verified,
  not at signup.
- **Google sign-in** links to an existing account by verified email. If that account was registered
  with a password but never verified, its password and sessions are discarded on link, so squatting
  on someone's address does not survive them signing in with Google.
- **Guests** get a signed id cookie the first time they do something that needs one, never on a
  plain page view.

## Design system

Tokens live in `packages/config`: `tailwind/theme.css` is the source of truth for the running UI,
`src/theme.ts` mirrors it for `next/og`, which cannot read a stylesheet. `theme.test.ts` fails if
the two drift, and also asserts WCAG AA contrast for every text tone against every surface in both
schemes, so a palette edit cannot quietly break legibility.

Light and dark are a single declaration per token via CSS `light-dark()`. System preference works
with no JavaScript and no flash of the wrong theme; the manual toggle only has to set
`color-scheme` on the root element.

## Running it

Prerequisites: Node >= 20.11, pnpm, Docker Desktop running.

```bash
pnpm install
cp .env.example .env        # every value has a working local default
docker compose up -d        # Postgres on 5432, Redis on 6379
pnpm db:migrate
pnpm db:seed                # ~48 public prompts, a private shelf, a collection
pnpm dev                    # web on :3000, api on :4000
```

**If an existing Postgres already owns port 5432**, the container will start but `localhost` will
resolve to the host install and `pnpm db:migrate` fails with `auth_failed` — the `shelf` role does
not exist there. Point the container somewhere free instead of stopping your own server:

```bash
# in .env
POSTGRES_PORT=5433
DATABASE_URL=postgresql://shelf:shelf@localhost:5433/shelf
```

then `docker compose up -d --force-recreate postgres`.

### Dependency versions

Toolchain versions are declared once, in the `catalog:` block of
`pnpm-workspace.yaml`, and referenced as `"typescript": "catalog:"` by each
package. Without that, `pnpm add` in one workspace resolves a different compiler
than its neighbours — which is exactly what happened here before the catalog
existed.

Two deliberate pins:

- **TypeScript stays on 5.9.** `typescript-eslint` 8 declares
  `typescript: >=4.8.4 <6.1.0`, so moving to 7 would silently drop type-aware
  linting — the rules that catch unsafe `any` flow. Revisit when it supports 7.
- **`zod-openapi` instead of `@asteasolutions/zod-to-openapi`.** The schemas are
  Zod 4; `zod-openapi` targets Zod 4 directly.

`pnpm audit` is clean at `moderate`. One override is in place: `drizzle-kit`
reaches esbuild 0.18 through the deprecated `@esbuild-kit` loader, carrying
GHSA-67mh-4wv8-2f99.

Password hashing uses `@node-rs/argon2` rather than the `argon2` package: same
argon2id, prebuilt binaries, so no node-gyp toolchain is needed to clone and
run on Windows.

No Gemini key is required. Without `GEMINI_API_KEY` the API uses `FakeProvider`, and every
model-backed tool still works end to end. Without `RESEND_API_KEY`, verification and reset links are
printed to the API log.

### Tests

```bash
pnpm typecheck
pnpm lint
pnpm test:unit          # template parser, scoring, palette contrast, env, app wiring
pnpm test:integration   # real Postgres: schema invariants and privacy.spec.ts
pnpm test:e2e           # Playwright                               (phase 9)
```

Integration tests need the Docker Postgres running. They create and migrate a sibling database per
package (`shelf_test_db`, `shelf_test_api`) so a run never touches your development data, and so
turbo can run both suites in parallel; within a package `fileParallelism: false` keeps files from
truncating each other.

`privacy.spec.ts` is the suite to watch. It asserts, for every surface that can return a prompt and
for every actor who is not the owner, that a private prompt cannot be reached: direct fetch, all four
public sort orders, search by title, body and tag, tag filtering, version history, a single version,
the collection it belongs to, the owned-prompt list, shelf search, and the fork list. The HTTP cases
are `it.todo` entries that land with the endpoints, so the remaining gap shows up in test output
rather than only in the brief.

### Environment

Every variable is documented with an example in [`.env.example`](.env.example). The API validates
all of them through a Zod schema at boot and refuses to start in production while the development
secrets are still in place.

## Roadmap

| Phase | Scope                                                                 | Status |
| ----- | --------------------------------------------------------------------- | ------ |
| 1     | Monorepo, configs, docker-compose, CI, template parser                | done   |
| 2     | Drizzle schema, migrations, seed, repository layer, `privacy.spec.ts`  | done   |
| 3     | Auth: email/password, Google, sessions, CSRF, verification, reset      | done   |
| 4     | Prompts CRUD, versions, diff, restore, fork, votes, reports, credits   | done   |
| 5     | Search, trending, public library pages with SSR and OG images          | done   |
| 6     | Signed-in shelf UI: sidebar, collections, editor, variables, history   | done   |
| 7     | LLM provider layer, test run streaming, compare, tighten, suggestions  | done   |
| 8     | Command palette, shortcuts, import/export, dark mode toggle, admin     | done   |
| 9     | Full test pass, accessibility audit, security checklist, deploy config | next   |

## Known limitations

- **The API integration tests crash intermittently on Node 24.15.0 on Windows.** This is a runtime
  fault, not a test failure: the Node process exits with `0xC0000409` and no output, and vitest
  reports "Worker exited unexpectedly". It needs Express and an HTTP client in the same process,
  which is what supertest does. A 15-line script with bare Express and supertest reproduces it (5
  crashes in 16 runs); on Node 22.23 the same script crashed 0 times in 16 and the full suite passed
  6 runs in 6. The running API is not affected: it served 12,000 requests from a separate client
  process on Node 24 without dying. CI runs Node 22, and `.nvmrc` pins it; use Node 22 to run
  `pnpm test:integration` on Windows.

- **Guest credits are a speed bump, not security.** Identity is a signed cookie plus an HMAC of the
  client IP. Clearing cookies from a new address resets the allowance. Turnstile raises the cost,
  the global daily LLM cap bounds the damage, and neither makes this airtight. Anything that must
  not be abused requires an account.
- **Free tiers sleep.** Render and Neon free instances idle out, so the first request after a quiet
  period can take several seconds.
- **Public listings paginate by offset, not by cursor.** Keyset pagination over `trending_score` is
  awkward when a cron job rewrites the score every 15 minutes, and at this library's size the deep
  pages offset would hurt do not exist. A prompt can shift between pages if the score is recomputed
  mid-browse. `new` could use a stable `(created_at, id)` cursor; mixing two schemes was not worth
  the complexity yet.
- **Upvote and fork counts are denormalised** onto `prompts`, with the vote rows as the source of
  truth. The seed writes plausible counters directly rather than generating thousands of vote rows,
  so seeded counts do not reconcile against `votes`.
- **Trending scores go stale between recomputes.** The seed computes them once; in a running system
  the scheduled job owns them.

Further limitations are recorded as the phases that introduce them land.

## License

MIT.
