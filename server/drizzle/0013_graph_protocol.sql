ALTER TABLE "accounts" ADD COLUMN "protocol" text DEFAULT 'imap' NOT NULL;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "remote_id" text;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "delta_link" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "remote_id" text;--> statement-breakpoint
CREATE INDEX "messages_remote_id" ON "messages" USING btree ("account_id","remote_id");--> statement-breakpoint
-- 微软 OAuth 账户改走 Graph API（需要重新授权以获得 Graph 权限）
UPDATE "accounts" SET "protocol" = 'graph' WHERE "auth_type" = 'oauth2' AND "provider" = 'outlook';
