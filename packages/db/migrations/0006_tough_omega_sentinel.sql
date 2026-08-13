CREATE TYPE "public"."change_request_kind" AS ENUM('memory', 'autonomy');--> statement-breakpoint
CREATE TYPE "public"."change_request_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "change_request_kind" NOT NULL,
	"status" "change_request_status" DEFAULT 'pending' NOT NULL,
	"summary" text NOT NULL,
	"rationale" text,
	"payload" jsonb NOT NULL,
	"agent_run_id" uuid,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "change_requests_pending_idx" ON "change_requests" USING btree ("workspace_id","status");