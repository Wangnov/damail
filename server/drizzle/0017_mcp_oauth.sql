CREATE TABLE "mcp_authorizations" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "mcp_authorizations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"grant_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"client_id" text NOT NULL,
	"client_name" text,
	"resource" text NOT NULL,
	"scopes" text[] NOT NULL,
	"account_ids" integer[],
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_authorizations_grantId_unique" UNIQUE("grant_id")
);
--> statement-breakpoint
CREATE TABLE "oauth_payloads" (
	"model" text NOT NULL,
	"id_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"grant_id" text,
	"uid" text,
	"expires_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "oauth_payloads_model_id_hash_pk" PRIMARY KEY("model","id_hash")
);
--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "created_by_oauth_id" integer;--> statement-breakpoint
ALTER TABLE "mcp_authorizations" ADD CONSTRAINT "mcp_authorizations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_authorizations_user" ON "mcp_authorizations" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "oauth_payloads_grant" ON "oauth_payloads" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "oauth_payloads_uid" ON "oauth_payloads" USING btree ("model","uid");--> statement-breakpoint
CREATE INDEX "oauth_payloads_expires" ON "oauth_payloads" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_created_by_oauth_id_mcp_authorizations_id_fk" FOREIGN KEY ("created_by_oauth_id") REFERENCES "public"."mcp_authorizations"("id") ON DELETE set null ON UPDATE no action;