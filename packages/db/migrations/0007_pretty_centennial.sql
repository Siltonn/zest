CREATE TYPE "public"."plan_item_status" AS ENUM('planned', 'written', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."plan_status" AS ENUM('active', 'paused', 'archived');--> statement-breakpoint
CREATE TABLE "plan_accounts" (
	"plan_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	CONSTRAINT "plan_accounts_plan_id_account_id_pk" PRIMARY KEY("plan_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "plan_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"angle" text,
	"suggested_slot_at" timestamp with time zone,
	"status" "plan_item_status" DEFAULT 'planned' NOT NULL,
	"post_id" uuid,
	"agent_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"objective" text,
	"schedule" text DEFAULT 'weekly' NOT NULL,
	"status" "plan_status" DEFAULT 'active' NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "plan_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "account_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "output" text;--> statement-breakpoint
ALTER TABLE "plan_accounts" ADD CONSTRAINT "plan_accounts_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_accounts" ADD CONSTRAINT "plan_accounts_account_id_linked_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."linked_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_account_id_linked_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."linked_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_items_pending_idx" ON "plan_items" USING btree ("plan_id","account_id","status");--> statement-breakpoint
CREATE INDEX "plans_workspace_idx" ON "plans" USING btree ("workspace_id","status");