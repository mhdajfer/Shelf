# Security

What Shelf defends against, where each defence lives, and how it is checked. An item marked
**tested** has an automated test that fails if the defence is removed. The last section lists what
is deliberately not covered.

To report a vulnerability, email the address in `packages/config/src/brand.ts` (`supportEmail`).
Please do not open a public issue for it.

## Access control

| Defence | Where | Checked by |
| --- | --- | --- |
| One function decides who may read a prompt | `readableBy` in `packages/db/src/repositories/promptRepo.ts` | **tested**: `privacy.spec.ts`, every read path against every non-owner |
| A route cannot bypass it | `@shelf/db` does not export the tables; ESLint forbids `apps/api` importing `@shelf/db/schema` | lint |
| An unreadable prompt is indistinguishable from a missing one | Reads return `null`; routes answer 404 with one message | **tested**: `privacy.http.spec.ts` compares the two responses byte for byte |
| The same holds in the browser | Pages call `notFound()`; the share image and sitemap fetch with no cookies | **tested**: `e2e/privacy.spec.ts`, including the OG image and the Markdown export |
| Writes require ownership, separately from reads | `promptRepo.findOwned`; collections are scoped by the session's user id | **tested**: `prompts.spec.ts`, `collections.spec.ts` |
| Admin is not a master key | The admin clause widens reads to hidden *public* prompts only | **tested**: an admin gets 404 for a private prompt, and cannot resolve reports against one |
| A run's inputs are private to whoever ran it | `runRepo.listForActor` filters by actor, not by prompt owner | **tested**: `runs.spec.ts` |
| A version id cannot be used to reach another prompt | `findVersion` looks the version up through its own prompt's visibility | **tested**: `runs.spec.ts` |

## Authentication and sessions

| Defence | Where | Checked by |
| --- | --- | --- |
| Passwords are argon2id at OWASP's baseline cost | `apps/api/src/auth/password.ts` | review |
| Session and emailed tokens are stored as SHA-256 hashes | `sessions.id`, `email_tokens.token_hash` | review; a database dump cannot be replayed |
| Session cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` in production | `apps/api/src/auth/cookies.ts` | **tested**: `auth.spec.ts` |
| A new token on every sign-in | `startSession` | review; prevents session fixation |
| Logout and password reset revoke server-side | The session row is deleted | **tested**: a replayed cookie is refused |
| Login does not reveal whether an address is registered | One message, and a dummy hash verify for unknown addresses | **tested**: identical responses |
| Password reset does not reveal it either | Same answer for known and unknown addresses | **tested** |
| Emailed links are single-use and expire | Consumed in one `UPDATE … RETURNING` | **tested**: second use is refused; a newer link retires the older |
| Admin role is granted on verification, not signup | `roleFor` is applied when the address is proved | review |
| Google sign-in cannot be used to take over, or be taken over | Links only on a Google-verified email; an unverified password signup loses its password and sessions on link | **tested**: `auth.spec.ts` |
| OAuth callback is bound to the browser that started it | `state` cookie compared in constant time, plus PKCE | **tested**: a forged state is refused |
| Deleting an account needs the password, or the typed handle | `POST /auth/delete-account` | **tested** |
| Post-sign-in redirect cannot leave the site | `safeNext` accepts same-site paths only | review |

## Request forgery and cross-origin

| Defence | Where | Checked by |
| --- | --- | --- |
| Every state-changing request needs a CSRF token | Signed double-submit: `apps/api/src/auth/csrf.ts` | **tested**: missing, mismatched, and unsigned-but-matching tokens are all refused |
| CORS allows listed origins only, with credentials | `apps/api/src/app.ts` | **tested**: an unlisted origin gets 403 |
| The cron endpoint is the only CSRF exemption, and uses a bearer secret | Compared in constant time | **tested** |

## Injection and untrusted content

| Defence | Where | Checked by |
| --- | --- | --- |
| No string-built SQL from user input | Drizzle's parameterised `sql` template throughout | review |
| Search input cannot raise or inject | `websearch_to_tsquery` with a bound parameter | **tested**: punctuation-heavy queries |
| A malformed id is a 404, not a database error | `uuidParam` validates before the query | **tested** |
| Prompt bodies and model output are never rendered as HTML | Rendered as text nodes; Markdown goes through `rehype-sanitize` | ESLint forbids `dangerouslySetInnerHTML` in the web app |
| Scripts run only with a per-request nonce | `apps/web/src/proxy.ts`: `script-src 'nonce-…' 'strict-dynamic'`, no `unsafe-inline`, no `unsafe-eval` in production | **tested**: `e2e/library.spec.ts` asserts the header and a clean console |
| The page cannot be framed | `frame-ancestors 'none'` and `X-Frame-Options: DENY` | review |
| Request bodies are bounded | 64 kB, except `/import` at 8 MB; every string field has a schema maximum | **tested** for import |
| Exported Markdown cannot break out of its code fence | The fence is longer than any backtick run in the body | **tested** |

## Abuse and cost

| Defence | Where | Checked by |
| --- | --- | --- |
| Rate limits on sign-in, signup, reset, writes, votes, reports, search, model calls | Redis-backed, with an in-memory insurance limiter | **tested** for login lockout |
| Credits cannot be overspent by racing requests | Check-and-debit under a Postgres advisory lock | **tested**: eight concurrent spends against a limit of three |
| The credit ledger cannot be edited | Triggers reject `UPDATE` and `DELETE` | **tested**: `schema.spec.ts` |
| A failed model call is refunded exactly once | Compensating row; `refund` is idempotent | **tested** |
| A global ceiling on model calls per day | Checked before the debit | **tested** |
| One person cannot auto-hide a prompt | One report per actor, by partial unique index | **tested** |
| Public listings stay clean | `obscenity` on title, description, and tags of public prompts | **tested** |
| Bot check on guest posts and signup | Cloudflare Turnstile, when a real key is configured | review; not exercised by the test suite |

## Operations

| Defence | Where | Checked by |
| --- | --- | --- |
| The API will not start in production with development secrets | `parseEnv` | **tested** |
| Test-only switches are refused in production | `OFFLINE_MODE`, `RATE_LIMIT_DISABLED` | **tested** |
| Credentials are not logged | Pino redaction, and request logs carry method, URL, and status only | review |
| Responses that depend on the caller are not cached | `Cache-Control: no-store` on the API | review |
| Dependencies are audited in CI | `pnpm audit --audit-level=high` | CI |
| Postinstall scripts are opt-in | `allowBuilds` in `pnpm-workspace.yaml` | review |
| The container runs unprivileged | `USER node` in `apps/api/Dockerfile` | review |

## What is not covered

- **Guest limits are a speed bump.** A guest is a signed cookie plus a hash of the address. A new
  address with cleared cookies gets a fresh allowance. Turnstile and the global daily ceiling bound
  the damage; neither makes it airtight. Anything that must not be abused requires an account.
- **Styles are not nonce-protected.** `style-src` keeps `'unsafe-inline'`, because CodeMirror and
  the toast library inject style elements at runtime and Radix positions popovers with inline
  styles. Injected CSS cannot execute code, but it can restyle the page.
- **No two-factor authentication**, and no notification when a password changes.
- **No account lockout** beyond the per-address rate limit on sign-in.
- **Rate limits behind the web server see the web host's address** for server-rendered requests, so
  the search limit is set generously rather than per visitor.
- **The model can be prompted to say anything.** Output is rendered safely, but Shelf does not
  filter what a model returns for a run.
- **No penetration test has been done.** The checks above are automated tests and code review.
