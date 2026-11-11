CREATE TABLE "follow_ups" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "follow_ups_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"account_id" integer NOT NULL,
	"message_id" text NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"due_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"notified_at" timestamp with time zone,
	"replied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "follow_up_days" integer;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "follow_ups_message" ON "follow_ups" USING btree ("account_id","message_id");--> statement-breakpoint
CREATE INDEX "follow_ups_due" ON "follow_ups" USING btree ("status","due_at");