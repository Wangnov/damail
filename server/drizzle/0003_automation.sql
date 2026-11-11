CREATE TABLE "channels" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "channels_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"type" text NOT NULL,
	"config_enc" text NOT NULL,
	"events" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "jobs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "message_insights" (
	"message_id" bigint PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"priority" text NOT NULL,
	"summary" text NOT NULL,
	"needs_reply" boolean DEFAULT false NOT NULL,
	"extracted" jsonb NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "rules_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"account_ids" integer[],
	"match" text DEFAULT 'all' NOT NULL,
	"conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stop_processing" boolean DEFAULT false NOT NULL,
	"match_count" integer DEFAULT 0 NOT NULL,
	"last_matched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_insights" ADD CONSTRAINT "message_insights_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_queue" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX "jobs_type_created" ON "jobs" USING btree ("type","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "message_insights_category" ON "message_insights" USING btree ("category");--> statement-breakpoint
CREATE INDEX "message_insights_priority" ON "message_insights" USING btree ("priority");