CREATE TYPE "public"."access_token_kind" AS ENUM('pat', 'access', 'refresh');--> statement-breakpoint
CREATE TYPE "public"."grant_kind" AS ENUM('token', 'app');--> statement-breakpoint
CREATE TYPE "public"."prompt_set" AS ENUM('all', 'pinned', 'collection');--> statement-breakpoint
CREATE TABLE "access_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "grant_kind" NOT NULL,
	"name" text NOT NULL,
	"scopes" text[] NOT NULL,
	"prompt_set" "prompt_set" DEFAULT 'all' NOT NULL,
	"collection_id" uuid,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_grants_collection_check" CHECK ((prompt_set = 'collection') = (collection_id IS NOT NULL)),
	CONSTRAINT "access_grants_scopes_check" CHECK (scopes <@ ARRAY['prompts:read', 'prompts:write']::text[] AND 'prompts:read' = ANY (scopes))
);
--> statement-breakpoint
CREATE TABLE "access_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid NOT NULL,
	"kind" "access_token_kind" NOT NULL,
	"token_hash" text NOT NULL,
	"display" text NOT NULL,
	"family_id" uuid,
	"resource" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "prompts" ADD COLUMN "command_name" text;--> statement-breakpoint

-- Every user's prompt gets a command name from its title, oldest first, so the
-- oldest prompt keeps the plain name and later ones get -2, -3. The slug rule
-- matches slugifyCommandName in @shelf/shared except that accents are dropped
-- rather than folded (Postgres has no unaccent without an extension); owners
-- can rename. Deleted prompts get a name too, which the check below requires,
-- but are outside the unique index, so they never take a live prompt's name.
-- command_name is not an authored column, so this does not touch updated_at.
DO $$
DECLARE
  p record;
  base text;
  candidate text;
  n integer;
BEGIN
  FOR p IN
    SELECT id, owner_id, title, status FROM prompts
    WHERE owner_id IS NOT NULL
    ORDER BY created_at, id
  LOOP
    base := btrim(left(regexp_replace(lower(p.title), '[^a-z0-9]+', '-', 'g'), 48), '-');
    IF base = '' THEN
      base := 'prompt';
    END IF;
    candidate := base;
    n := 1;
    IF p.status <> 'deleted' THEN
      WHILE EXISTS (
        SELECT 1 FROM prompts
        WHERE owner_id = p.owner_id AND status <> 'deleted' AND command_name = candidate
      ) LOOP
        n := n + 1;
        candidate := rtrim(left(base, 48 - length('-' || n)), '-') || '-' || n;
      END LOOP;
    END IF;
    UPDATE prompts SET command_name = candidate WHERE id = p.id;
  END LOOP;
END
$$;--> statement-breakpoint

ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_grant_id_access_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."access_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_grants_user_idx" ON "access_grants" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "access_grants_collection_idx" ON "access_grants" USING btree ("collection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_tokens_hash_key" ON "access_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "access_tokens_grant_idx" ON "access_tokens" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "access_tokens_expires_idx" ON "access_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "prompts_owner_command_name_key" ON "prompts" USING btree ("owner_id","command_name") WHERE owner_id IS NOT NULL AND status <> 'deleted';--> statement-breakpoint
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_command_name_check" CHECK ((owner_id IS NULL) = (command_name IS NULL));--> statement-breakpoint
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_command_name_format_check" CHECK (command_name ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(command_name) <= 48);