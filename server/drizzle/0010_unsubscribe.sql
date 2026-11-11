CREATE TABLE "unsubscriptions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "unsubscriptions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"account_id" integer NOT NULL,
	"list_key" text NOT NULL,
	"sender" text,
	"method" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"message_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "list_info" jsonb;--> statement-breakpoint
ALTER TABLE "unsubscriptions" ADD CONSTRAINT "unsubscriptions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unsubscriptions" ADD CONSTRAINT "unsubscriptions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "unsubscriptions_list" ON "unsubscriptions" USING btree ("account_id","list_key");