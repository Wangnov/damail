CREATE TABLE "ignored_senders" (
	"pattern" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
