CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"event_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"description" text,
	"is_active" text DEFAULT 'true' NOT NULL,
	"last_status" integer,
	"last_error" text,
	"last_delivered_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"url" text NOT NULL,
	"storage_key" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"width" integer,
	"height" integer,
	"alt_text" text,
	"created_by_actor" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_endpoints_workspace_idx" ON "webhook_endpoints" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "media_assets_workspace_idx" ON "media_assets" USING btree ("workspace_id","created_at");