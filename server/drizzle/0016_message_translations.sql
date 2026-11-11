CREATE TABLE "message_translations" (
	"message_id" bigint NOT NULL,
	"language" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"html" text,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_translations_message_id_language_pk" PRIMARY KEY("message_id","language")
);
--> statement-breakpoint
ALTER TABLE "message_translations" ADD CONSTRAINT "message_translations_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;