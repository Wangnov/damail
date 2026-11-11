CREATE TABLE "proxies" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "proxies_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"protocol" text NOT NULL,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"username" text,
	"password_enc" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "proxy_id" integer;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_proxy_id_proxies_id_fk" FOREIGN KEY ("proxy_id") REFERENCES "public"."proxies"("id") ON DELETE set null ON UPDATE no action;