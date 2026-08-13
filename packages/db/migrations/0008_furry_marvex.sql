-- Cadence moves from the workspace onto plans.
--
-- Every existing workspace becomes one always-on programme covering all of its
-- accounts, carrying the cadence it already had. Done before the column is
-- dropped so nobody's schedule is silently lost on upgrade.
INSERT INTO "plans" ("workspace_id", "name", "objective", "schedule", "status")
SELECT
  "id",
  'Always-on',
  'Steady coverage of the brand''s usual subjects.',
  "planning_schedule",
  'active'
FROM "workspaces"
WHERE NOT EXISTS (SELECT 1 FROM "plans" WHERE "plans"."workspace_id" = "workspaces"."id");
--> statement-breakpoint
INSERT INTO "plan_accounts" ("plan_id", "account_id")
SELECT "plans"."id", "linked_accounts"."id"
FROM "plans"
JOIN "linked_accounts" ON "linked_accounts"."workspace_id" = "plans"."workspace_id"
WHERE "plans"."name" = 'Always-on'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "planning_schedule";
