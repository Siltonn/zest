import { randomBytes, createHash, scryptSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabase } from "@zest/db";
import { schema } from "@zest/db";

/**
 * Seeds a workspace that is immediately demonstrable: a brand with a voice,
 * two Pomelo accounts that sound like different people, a populated network of
 * residents, and trending topics for the agent to react to.
 *
 * Deterministic on purpose — a demo should tell the same story twice.
 */

import { PERSONA_SEEDS, TREND_SEEDS, avatarFor } from "@zest/simulator";
import { getTokenVault } from "@zest/shared";

const DEMO_EMAIL = "demo@zest.local";
const DEMO_PASSWORD = "zestdemo";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const db = createDatabase(url);

  console.info("Seeding Zest…");

  // ── Operator ──────────────────────────────────────────────────────────
  const [existingUser] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, DEMO_EMAIL));

  const userId = existingUser?.id ?? `user_${randomBytes(8).toString("hex")}`;
  if (!existingUser) {
    await db.insert(schema.users).values({
      id: userId,
      name: "Demo Operator",
      email: DEMO_EMAIL,
      emailVerified: true,
    });
    // Better Auth stores a scrypt hash as salt:key.
    const salt = randomBytes(16).toString("hex");
    const key = scryptSync(DEMO_PASSWORD, salt, 64).toString("hex");
    await db.insert(schema.accounts).values({
      id: `acct_${randomBytes(8).toString("hex")}`,
      userId,
      accountId: userId,
      providerId: "credential",
      password: `${salt}:${key}`,
    });
  }

  // ── Workspace ─────────────────────────────────────────────────────────
  const [existingWorkspace] = await db.select().from(schema.workspaces).limit(1);
  const workspace =
    existingWorkspace ??
    (
      await db
        .insert(schema.workspaces)
        .values({
          name: "Nimbus Tools",
          timezone: "America/New_York",
          kpiConfig: { goal: "Grow to 5,000 followers and hold engagement above 3%" },
          // Demo mode runs the simulated clock fast so a fast-forward is dramatic.
          demoClockMultiplier: 60,
          simClockAt: new Date(),
        })
        .returning()
    )[0]!;

  await db
    .insert(schema.memberships)
    .values({ workspaceId: workspace.id, userId, role: "owner" })
    .onConflictDoNothing();

  // ── Pomelo residents ──────────────────────────────────────────────────
  const [residentCount] = await db.select().from(schema.pomeloUsers).limit(1);
  if (!residentCount) {
    await db.insert(schema.pomeloUsers).values(
      PERSONA_SEEDS.map((persona) => ({
        handle: persona.handle,
        displayName: persona.displayName,
        avatarUrl: avatarFor(persona.handle),
        bio: persona.bio,
        isPersona: true,
        personaConfig: persona.config,
        followerCount: persona.followerCount,
      })),
    );
    console.info(`  ${PERSONA_SEEDS.length} Pomelo residents`);
  }

  // Guarded separately from personas, and idempotent regardless: seeding twice
  // must never produce two of the same topic.
  await db
    .insert(schema.pomeloTrends)
    .values(
      TREND_SEEDS.map((trend) => ({
        topic: trend.topic,
        momentum: trend.momentum,
        dayIndex: 0,
      })),
    )
    .onConflictDoNothing();

  // ── Two connected accounts, deliberately different voices ─────────────
  const [existingAccount] = await db
    .select()
    .from(schema.linkedAccounts)
    .where(eq(schema.linkedAccounts.workspaceId, workspace.id))
    .limit(1);

  if (!existingAccount) {
    const accounts = [
      {
        handle: "nimbustools",
        displayName: "Nimbus Tools",
        persona: `# Voice: @nimbustools (company account)

Measured, useful, never breathless. This account earns attention by being
worth reading, not by being loud.

- Speaks as "we". Credits the team, never a single hero.
- Leads with the concrete thing: what changed, what it costs, what broke.
- Numbers where we have them. No numbers rather than invented ones.
- Dry humour is fine. Exclamation marks are not.
- Never uses "excited to announce", "game-changer", "revolutionise".
- At most one hashtag, and only if that community actually uses it.

Content mix: 50% practical how-to, 30% product and engineering notes,
20% commentary on the wider ecosystem.

Avoid: pricing debates, competitor comparisons by name, hiring posts.`,
      },
      {
        handle: "rae_builds",
        displayName: "Rae Okafor",
        persona: `# Voice: @rae_builds (founder account)

Rae is one person thinking out loud. Warmer and more uncertain than the
company account — that is the point of it existing.

- Speaks as "I". Shares the messy middle, not just outcomes.
- Comfortable saying "I don't know yet" or "this was a mistake".
- Asks real questions and actually reads the answers.
- Short sentences. Occasional fragments. Sounds like talking.
- Never markets. If it reads like a press release, rewrite it.
- No hashtags.

Content mix: 40% building-in-public notes, 30% questions to the community,
30% reactions to things happening in the ecosystem.

Avoid: anything that sounds like the company account. If both accounts would
post the same sentence, this one is wrong.`,
      },
    ];

    for (const account of accounts) {
      const apiKey = `pomelo_${randomBytes(18).toString("base64url")}`;
      const [pomeloUser] = await db
        .insert(schema.pomeloUsers)
        .values({
          handle: account.handle,
          displayName: account.displayName,
          avatarUrl: avatarFor(account.handle),
          bio:
            account.handle === "nimbustools"
              ? "Developer tools that get out of the way."
              : "Building Nimbus. Learning in public.",
          isPersona: false,
          apiKey,
          followerCount: account.handle === "nimbustools" ? 1240 : 680,
        })
        .returning();

      const [linked] = await db
        .insert(schema.linkedAccounts)
        .values({
          workspaceId: workspace.id,
          connectorId: "pomelo",
          handle: account.handle,
          displayName: account.displayName,
          avatarUrl: avatarFor(account.handle),
          profileUrl: `/pomelo/@${account.handle}`,
          externalId: pomeloUser!.id,
          endpoint: process.env.POMELO_API_URL ?? "http://localhost:4000/pomelo",
          accessTokenEnc: getTokenVault().encrypt(apiKey),
        })
        .returning();

      await db.insert(schema.memoryDocs).values({
        workspaceId: workspace.id,
        scope: "account",
        accountId: linked!.id,
        kind: "persona",
        version: 1,
        contentMd: account.persona,
        updatedByActor: { kind: "human", userId },
      });
    }
    console.info("  2 connected Pomelo accounts with distinct voice cards");
  }

  // ── Plans ─────────────────────────────────────────────────────────────
  // Two programmes rather than one, because the interesting part of the model
  // is that they differ: a steady always-on beat for the brand, and a faster
  // founder cadence, both fed by the same research.
  const [existingPlan] = await db
    .select()
    .from(schema.plans)
    .where(eq(schema.plans.workspaceId, workspace.id))
    .limit(1);

  if (!existingPlan) {
    const accounts = await db
      .select()
      .from(schema.linkedAccounts)
      .where(eq(schema.linkedAccounts.workspaceId, workspace.id));
    const brand = accounts.find((a) => a.handle === "nimbustools") ?? accounts[0]!;
    const founder = accounts.find((a) => a.handle === "rae_builds") ?? accounts[0]!;

    const [alwaysOn] = await db
      .insert(schema.plans)
      .values({
        workspaceId: workspace.id,
        name: "Always-on",
        objective:
          "Steady coverage of what we are building and what we are learning, without sounding like a changelog.",
        schedule: "weekly",
        status: "active",
      })
      .returning();

    const [riffs] = await db
      .insert(schema.plans)
      .values({
        workspaceId: workspace.id,
        name: "Founder riffs",
        objective:
          "Rae's own voice: opinions, mistakes, and things learned the hard way. Never a product announcement.",
        schedule: "weekdays",
        status: "active",
      })
      .returning();

    await db.insert(schema.planAccounts).values([
      { planId: alwaysOn!.id, accountId: brand.id },
      { planId: alwaysOn!.id, accountId: founder.id },
      { planId: riffs!.id, accountId: founder.id },
    ]);

    console.info("  2 plans — a shared always-on beat and a founder-only cadence");
  }

  // ── Brand memory ──────────────────────────────────────────────────────
  const [existingBrief] = await db
    .select()
    .from(schema.memoryDocs)
    .where(eq(schema.memoryDocs.kind, "brand_brief"))
    .limit(1);

  if (!existingBrief) {
    await db.insert(schema.memoryDocs).values([
      {
        workspaceId: workspace.id,
        scope: "workspace" as const,
        kind: "brand_brief" as const,
        version: 1,
        contentMd: `# Nimbus Tools

## What we make
Self-hosted developer tooling. Our flagship is a build cache that works
without a SaaS account — you run it, you own the data.

## Who we talk to
Backend and platform engineers at small teams, and indie developers who
self-host by preference rather than by budget. They are sceptical of
marketing, allergic to hype, and will read a changelog for fun.

## What we stand for
- Own your infrastructure. No lock-in, no phone-home.
- Say what something costs, including in complexity.
- Ship small and often, and write down what broke.

## What we avoid
- Claiming to be the first or only anything.
- Speaking badly of competitors by name.
- Announcing things that are not usable yet.
- AI as a buzzword. We use it where it earns its place, and say how.`,
        updatedByActor: { kind: "human" as const, userId },
      },
      {
        workspaceId: workspace.id,
        scope: "workspace" as const,
        kind: "strategy" as const,
        version: 1,
        contentMd: `# Current strategy

Goal: 5,000 followers in 90 days, engagement rate above 3%.

## Cadence
Five posts a week across the two accounts. The company account carries the
practical material; the founder account carries the thinking-out-loud.

## Working hypotheses
- Specific how-to posts outperform opinion pieces. Weight toward how-to.
- Weekday mornings beat evenings for this audience.
- Posts that ask a real question get replies worth having.

These are hypotheses, not findings. Update them when the numbers say so.`,
        updatedByActor: { kind: "human" as const, userId },
      },
      {
        workspaceId: workspace.id,
        scope: "workspace" as const,
        kind: "learnings" as const,
        version: 1,
        contentMd: `# Learnings

Nothing yet — not enough posts have run to draw a conclusion from.

Record findings here only when they hold up across several posts. Two data
points is a coincidence, not a pattern.`,
        updatedByActor: { kind: "human" as const, userId },
      },
    ]);
    console.info("  brand brief, strategy and learnings");
  }

  // ── A notification target so approvals are visibly delivered ──────────
  const [existingTarget] = await db
    .select()
    .from(schema.notificationTargets)
    .where(eq(schema.notificationTargets.workspaceId, workspace.id))
    .limit(1);

  if (!existingTarget) {
    await db.insert(schema.notificationTargets).values({
      workspaceId: workspace.id,
      kind: "email",
      config: { email: DEMO_EMAIL },
      digestMode: "instant",
    });
  }

  // ── An API key, so the MCP demo needs no setup ────────────────────────
  const [existingKey] = await db
    .select()
    .from(schema.apiKeys)
    .where(eq(schema.apiKeys.workspaceId, workspace.id))
    .limit(1);

  if (!existingKey) {
    const secret = "zest_demo_key_do_not_use_in_production";
    await db.insert(schema.apiKeys).values({
      workspaceId: workspace.id,
      name: "Demo key (MCP)",
      hashedKey: createHash("sha256").update(secret).digest("hex"),
      scopes: ["read", "write"],
    });
    console.info(`  API key for MCP: ${secret}`);
  }

  console.info(`\nReady. Sign in as ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  console.info("Open http://localhost:3000\n");
  process.exit(0);
}

void main().catch((error) => {
  console.error("Seeding failed:", error);
  process.exit(1);
});
