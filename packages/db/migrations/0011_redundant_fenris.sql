CREATE TYPE "public"."plan_kind" AS ENUM('fresh', 'evergreen');--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "kind" "plan_kind" DEFAULT 'fresh' NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "recycled_from_id" uuid;