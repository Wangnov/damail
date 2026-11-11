CREATE TABLE "accounts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "accounts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"email" text NOT NULL,
	"provider" text DEFAULT 'custom' NOT NULL,
	"color" text,
	"imap_host" text NOT NULL,
	"imap_port" integer DEFAULT 993 NOT NULL,
	"imap_secure" boolean DEFAULT true NOT NULL,
	"smtp_host" text,
	"smtp_port" integer,
	"smtp_secure" boolean,
	"username" text NOT NULL,
	"auth_type" text DEFAULT 'password' NOT NULL,
	"secret_enc" text NOT NULL,
	"sync_since_days" integer DEFAULT 90 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'connecting' NOT NULL,
	"last_error" text,
	"last_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "api_keys_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] DEFAULT ARRAY['read']::text[] NOT NULL,
	"account_ids" integer[],
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_keyHash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "folders_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"account_id" integer NOT NULL,
	"path" text NOT NULL,
	"name" text NOT NULL,
	"delimiter" text,
	"special_use" text,
	"sync_enabled" boolean DEFAULT false NOT NULL,
	"uid_validity" bigint,
	"last_uid" bigint DEFAULT 0 NOT NULL,
	"highest_modseq" bigint,
	"total_count" integer DEFAULT 0 NOT NULL,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"last_sync_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"account_id" integer NOT NULL,
	"folder_id" integer NOT NULL,
	"uid" bigint NOT NULL,
	"message_id" text,
	"thread_id" text NOT NULL,
	"in_reply_to" text,
	"references" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"from_name" text,
	"from_address" text,
	"to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reply_to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"snippet" text DEFAULT '' NOT NULL,
	"text_body" text,
	"html_body" text,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"has_attachments" boolean DEFAULT false NOT NULL,
	"flags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"seen" boolean DEFAULT false NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"answered" boolean DEFAULT false NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"raw_path" text,
	"search_text" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "folders_account_path" ON "folders" USING btree ("account_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_folder_uid" ON "messages" USING btree ("folder_id","uid");--> statement-breakpoint
CREATE INDEX "messages_account_date" ON "messages" USING btree ("account_id","date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "messages_date" ON "messages" USING btree ("date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "messages_thread" ON "messages" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "messages_message_id" ON "messages" USING btree ("account_id","message_id");--> statement-breakpoint
CREATE INDEX "messages_references" ON "messages" USING gin ("references");--> statement-breakpoint
CREATE INDEX "messages_search_trgm" ON "messages" USING gin ("search_text" gin_trgm_ops);