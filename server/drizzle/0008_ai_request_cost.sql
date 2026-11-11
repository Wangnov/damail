ALTER TABLE "ai_requests" ADD COLUMN "cache_write_tokens" integer;--> statement-breakpoint
ALTER TABLE "ai_requests" ADD COLUMN "cost" double precision;