ALTER TABLE "oauth_access_tokens" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "oauth_applications" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "oauth_consents" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "oauth_access_tokens" CASCADE;--> statement-breakpoint
DROP TABLE "oauth_applications" CASCADE;--> statement-breakpoint
DROP TABLE "oauth_consents" CASCADE;--> statement-breakpoint
--> Better Auth 1.7 keys an account by (issuer, accountId). Existing rows are
--> all local email/password accounts, which the library writes as
--> `local:credential`, so the column is added nullable, backfilled from the
--> provider, and only then constrained. Adding it NOT NULL outright — which is
--> what the generator emits — fails on any database that already has a user.
ALTER TABLE "accounts" ADD COLUMN "issuer" text;--> statement-breakpoint
UPDATE "accounts" SET "issuer" = 'local:' || "provider_id" WHERE "issuer" IS NULL;--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "issuer" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "accounts_user_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");