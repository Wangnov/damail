CREATE TABLE "contact_aliases" (
	"address" text PRIMARY KEY NOT NULL,
	"alias" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "signature_html" text;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "body_format" text DEFAULT 'rich' NOT NULL;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "include_signature" boolean DEFAULT true NOT NULL;