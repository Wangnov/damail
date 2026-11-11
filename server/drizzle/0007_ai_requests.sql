CREATE TABLE "ai_requests" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ai_requests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"purpose" text NOT NULL,
	"channel_id" text,
	"channel_name" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"ok" boolean NOT NULL,
	"error" text,
	"duration_ms" integer NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ai_requests_created" ON "ai_requests" USING btree ("created_at");