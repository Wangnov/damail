ALTER TABLE "audit_logs" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "ip" text;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "user_agent" text;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "status" integer;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
CREATE INDEX "audit_logs_actor_created" ON "audit_logs" USING btree ("actor","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_action_created" ON "audit_logs" USING btree ("action","created_at" DESC NULLS LAST);