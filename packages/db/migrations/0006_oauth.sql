CREATE TYPE "public"."oauth_client_kind" AS ENUM('registered', 'metadata_document');--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"kind" "oauth_client_kind" NOT NULL,
	"name" text NOT NULL,
	"redirect_uris" text[] NOT NULL,
	"metadata_fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_clients_redirect_uris_check" CHECK (cardinality(redirect_uris) BETWEEN 1 AND 10),
	CONSTRAINT "oauth_clients_metadata_check" CHECK ((kind = 'metadata_document') = (metadata_fetched_at IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "oauth_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"scopes" text[] NOT NULL,
	"resource" text NOT NULL,
	"state" text,
	"expires_at" timestamp with time zone NOT NULL,
	"grant_id" uuid,
	"code_hash" text,
	"code_expires_at" timestamp with time zone,
	"family_id" uuid,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_requests_code_check" CHECK ((code_hash IS NULL) = (grant_id IS NULL) AND (code_hash IS NULL) = (code_expires_at IS NULL) AND (code_hash IS NULL) = (family_id IS NULL))
);
--> statement-breakpoint
ALTER TABLE "access_grants" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_requests" ADD CONSTRAINT "oauth_requests_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_requests" ADD CONSTRAINT "oauth_requests_grant_id_access_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."access_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_clients_client_id_key" ON "oauth_clients" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_requests_code_hash_key" ON "oauth_requests" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "oauth_requests_expires_idx" ON "oauth_requests" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_requests_grant_idx" ON "oauth_requests" USING btree ("grant_id");--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "access_grants_user_client_key" ON "access_grants" USING btree ("user_id","client_id") WHERE kind = 'app';--> statement-breakpoint
CREATE INDEX "access_tokens_family_idx" ON "access_tokens" USING btree ("family_id");--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_client_check" CHECK ((kind = 'app') = (client_id IS NOT NULL));