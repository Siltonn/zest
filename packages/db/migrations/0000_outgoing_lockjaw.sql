CREATE TYPE "public"."agent_role" AS ENUM('researcher', 'strategist', 'copywriter', 'community', 'analyst');--> statement-breakpoint
CREATE TYPE "public"."agent_run_status" AS ENUM('running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."agent_trigger" AS ENUM('cron_plan', 'event_reply', 'cron_analyze', 'chat', 'mcp', 'manual');--> statement-breakpoint
CREATE TYPE "public"."autonomy_action" AS ENUM('propose_post', 'schedule_post', 'send_reply', 'update_memory', 'engagement_automation');--> statement-breakpoint
CREATE TYPE "public"."autonomy_mode" AS ENUM('approve', 'auto');--> statement-breakpoint
CREATE TYPE "public"."digest_mode" AS ENUM('instant', 'daily');--> statement-breakpoint
CREATE TYPE "public"."inbound_kind" AS ENUM('reply', 'mention', 'dm');--> statement-breakpoint
CREATE TYPE "public"."inbound_status" AS ENUM('new', 'triaged', 'replied', 'ignored');--> statement-breakpoint
CREATE TYPE "public"."memory_kind" AS ENUM('brand_brief', 'strategy', 'learnings', 'persona');--> statement-breakpoint
CREATE TYPE "public"."memory_scope" AS ENUM('workspace', 'account');--> statement-breakpoint
CREATE TYPE "public"."metric" AS ENUM('impressions', 'likes', 'reposts', 'replies', 'followers');--> statement-breakpoint
CREATE TYPE "public"."notification_kind" AS ENUM('email', 'slack', 'discord');--> statement-breakpoint
CREATE TYPE "public"."post_status" AS ENUM('draft', 'pending_approval', 'needs_changes', 'approved', 'scheduled', 'publishing', 'published', 'failed', 'rejected', 'expired', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."sentiment" AS ENUM('positive', 'neutral', 'negative', 'hostile');--> statement-breakpoint
CREATE TYPE "public"."sim_event_kind" AS ENUM('impression', 'like', 'repost', 'reply', 'follow');--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"role" "agent_role",
	"trigger" "agent_trigger" NOT NULL,
	"status" "agent_run_status" DEFAULT 'running' NOT NULL,
	"model" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"transcript" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"actor" jsonb NOT NULL,
	"diff" jsonb,
	"agent_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "autonomy_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"action" "autonomy_action" NOT NULL,
	"connector_id" text,
	"account_id" uuid,
	"conditions" jsonb,
	"mode" "autonomy_mode" DEFAULT 'approve' NOT NULL,
	"granted_by" text,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metric_points" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"post_id" uuid,
	"metric" "metric" NOT NULL,
	"value" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"config" jsonb NOT NULL,
	"digest_mode" "digest_mode" DEFAULT 'instant' NOT NULL,
	"quiet_hours" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"id_token" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'owner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pomelo_follows" (
	"follower_id" uuid NOT NULL,
	"followee_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pomelo_follows_follower_id_followee_id_pk" PRIMARY KEY("follower_id","followee_id")
);
--> statement-breakpoint
CREATE TABLE "pomelo_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"author_id" uuid NOT NULL,
	"text" text NOT NULL,
	"media" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"like_count" integer DEFAULT 0 NOT NULL,
	"repost_count" integer DEFAULT 0 NOT NULL,
	"reply_count" integer DEFAULT 0 NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pomelo_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pomelo_trends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic" text NOT NULL,
	"momentum" integer DEFAULT 50 NOT NULL,
	"day_index" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pomelo_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"handle" text NOT NULL,
	"display_name" text NOT NULL,
	"avatar_url" text NOT NULL,
	"bio" text,
	"is_persona" boolean DEFAULT true NOT NULL,
	"persona_config" jsonb,
	"follower_count" integer DEFAULT 0 NOT NULL,
	"api_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pomelo_users_handle_unique" UNIQUE("handle")
);
--> statement-breakpoint
CREATE TABLE "sim_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"actor_id" uuid,
	"kind" "sim_event_kind" NOT NULL,
	"payload" jsonb,
	"fire_at_sim" timestamp with time zone NOT NULL,
	"fired" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" "inbound_kind" NOT NULL,
	"external_id" text NOT NULL,
	"author_handle" text NOT NULL,
	"author_name" text,
	"author_avatar_url" text,
	"text" text NOT NULL,
	"sentiment" "sentiment",
	"post_id" uuid,
	"status" "inbound_status" DEFAULT 'new' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "linked_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connector_id" text NOT NULL,
	"handle" text NOT NULL,
	"display_name" text,
	"avatar_url" text,
	"profile_url" text,
	"external_id" text,
	"access_token_enc" text,
	"refresh_token_enc" text,
	"token_expires_at" timestamp with time zone,
	"is_active" text DEFAULT 'true' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"status" "post_status" DEFAULT 'draft' NOT NULL,
	"content" jsonb NOT NULL,
	"suggested_slot_at" timestamp with time zone,
	"scheduled_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"external_id" text,
	"external_url" text,
	"error_message" text,
	"reasoning" text,
	"created_by_actor" jsonb NOT NULL,
	"agent_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reply_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"inbound_item_id" uuid NOT NULL,
	"status" "post_status" DEFAULT 'pending_approval' NOT NULL,
	"content" jsonb NOT NULL,
	"reasoning" text,
	"external_id" text,
	"external_url" text,
	"error_message" text,
	"created_by_actor" jsonb NOT NULL,
	"agent_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"hashed_key" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_hashedKey_unique" UNIQUE("hashed_key")
);
--> statement-breakpoint
CREATE TABLE "memory_docs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"scope" "memory_scope" NOT NULL,
	"account_id" uuid,
	"kind" "memory_kind" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"content_md" text NOT NULL,
	"updated_by_actor" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"planning_schedule" text DEFAULT 'daily' NOT NULL,
	"kpi_config" jsonb,
	"demo_clock_multiplier" integer DEFAULT 1 NOT NULL,
	"sim_clock_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_rules" ADD CONSTRAINT "autonomy_rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_rules" ADD CONSTRAINT "autonomy_rules_account_id_linked_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."linked_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_points" ADD CONSTRAINT "metric_points_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_points" ADD CONSTRAINT "metric_points_account_id_linked_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."linked_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_points" ADD CONSTRAINT "metric_points_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_targets" ADD CONSTRAINT "notification_targets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pomelo_follows" ADD CONSTRAINT "pomelo_follows_follower_id_pomelo_users_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."pomelo_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pomelo_follows" ADD CONSTRAINT "pomelo_follows_followee_id_pomelo_users_id_fk" FOREIGN KEY ("followee_id") REFERENCES "public"."pomelo_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pomelo_posts" ADD CONSTRAINT "pomelo_posts_author_id_pomelo_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."pomelo_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pomelo_replies" ADD CONSTRAINT "pomelo_replies_post_id_pomelo_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."pomelo_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pomelo_replies" ADD CONSTRAINT "pomelo_replies_author_id_pomelo_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."pomelo_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_events" ADD CONSTRAINT "sim_events_post_id_pomelo_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."pomelo_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_events" ADD CONSTRAINT "sim_events_actor_id_pomelo_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."pomelo_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_items" ADD CONSTRAINT "inbound_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_items" ADD CONSTRAINT "inbound_items_account_id_linked_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."linked_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_items" ADD CONSTRAINT "inbound_items_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linked_accounts" ADD CONSTRAINT "linked_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_account_id_linked_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."linked_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_drafts" ADD CONSTRAINT "reply_drafts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_drafts" ADD CONSTRAINT "reply_drafts_inbound_item_id_inbound_items_id_fk" FOREIGN KEY ("inbound_item_id") REFERENCES "public"."inbound_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_docs" ADD CONSTRAINT "memory_docs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_workspace_idx" ON "agent_runs" USING btree ("workspace_id","started_at");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_logs_workspace_idx" ON "audit_logs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "autonomy_rules_lookup_idx" ON "autonomy_rules" USING btree ("workspace_id","action");--> statement-breakpoint
CREATE INDEX "metric_points_lookup_idx" ON "metric_points" USING btree ("account_id","metric","at");--> statement-breakpoint
CREATE INDEX "notification_targets_workspace_idx" ON "notification_targets" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "pomelo_posts_author_idx" ON "pomelo_posts" USING btree ("author_id","created_at");--> statement-breakpoint
CREATE INDEX "pomelo_replies_post_idx" ON "pomelo_replies" USING btree ("post_id","created_at");--> statement-breakpoint
CREATE INDEX "pomelo_users_persona_idx" ON "pomelo_users" USING btree ("is_persona");--> statement-breakpoint
CREATE INDEX "sim_events_due_idx" ON "sim_events" USING btree ("fired","fire_at_sim");--> statement-breakpoint
CREATE INDEX "inbound_account_status_idx" ON "inbound_items" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "inbound_external_idx" ON "inbound_items" USING btree ("account_id","external_id");--> statement-breakpoint
CREATE INDEX "linked_accounts_workspace_idx" ON "linked_accounts" USING btree ("workspace_id","connector_id");--> statement-breakpoint
CREATE INDEX "posts_workspace_status_idx" ON "posts" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "posts_due_idx" ON "posts" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "reply_drafts_workspace_status_idx" ON "reply_drafts" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "api_keys_workspace_idx" ON "api_keys" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "memory_docs_lookup_idx" ON "memory_docs" USING btree ("workspace_id","kind","account_id","version");