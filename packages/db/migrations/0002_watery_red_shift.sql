CREATE TYPE "public"."automation_kind" AS ENUM('auto_plug', 'auto_reply', 'auto_dm');--> statement-breakpoint
CREATE TABLE "engagement_automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"account_id" uuid,
	"kind" "automation_kind" NOT NULL,
	"trigger" jsonb NOT NULL,
	"template" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "engagement_automations" ADD CONSTRAINT "engagement_automations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_automations" ADD CONSTRAINT "engagement_automations_account_id_linked_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."linked_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "engagement_automations_workspace_idx" ON "engagement_automations" USING btree ("workspace_id");