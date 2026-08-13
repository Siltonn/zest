import { and, eq, inArray, schema, sql, type Database } from "@zest/db";

/**
 * What a new workspace still has to do.
 *
 * An agent product has an awkward first five minutes: the dashboard is empty,
 * and nothing on it explains that the agent cannot plan anything until it knows
 * whose voice it is writing in. Rather than a tour that shows once and is gone,
 * this reads the actual state of the workspace — so a step ticks off when the
 * work is genuinely done, and comes back if the account is later disconnected.
 */

export type OnboardingStep = {
  id: string;
  title: string;
  description: string;
  /** Where the work happens. */
  href: string;
  cta: string;
  done: boolean;
};

export type OnboardingState = {
  complete: boolean;
  doneCount: number;
  steps: OnboardingStep[];
};

export async function readOnboarding(
  db: Database,
  workspaceId: string,
): Promise<OnboardingState> {
  const [accounts] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.linkedAccounts)
    .where(eq(schema.linkedAccounts.workspaceId, workspaceId));

  const docs = await db
    .select({
      kind: schema.memoryDocs.kind,
      accountId: schema.memoryDocs.accountId,
      contentMd: schema.memoryDocs.contentMd,
    })
    .from(schema.memoryDocs)
    .where(eq(schema.memoryDocs.workspaceId, workspaceId));

  const [runs] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.agentRuns)
    .where(
      and(
        eq(schema.agentRuns.workspaceId, workspaceId),
        inArray(schema.agentRuns.trigger, ["cron_plan", "manual", "chat", "mcp"]),
      ),
    );

  const [reviewed] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.posts)
    .where(
      and(
        eq(schema.posts.workspaceId, workspaceId),
        inArray(schema.posts.status, [
          "approved",
          "scheduled",
          "publishing",
          "published",
          "rejected",
        ]),
      ),
    );

  const [published] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.posts)
    .where(
      and(
        eq(schema.posts.workspaceId, workspaceId),
        eq(schema.posts.status, "published"),
      ),
    );

  const hasAccount = (accounts?.n ?? 0) > 0;
  // A brief that is still the starter template has not been written yet — the
  // row existing is not the same as somebody having said who the brand is.
  const brief = docs.find((d) => d.kind === "brand_brief");
  const hasBrief = Boolean(brief) && !isPlaceholder(brief?.contentMd ?? "");
  const personas = docs.filter((d) => d.kind === "persona");
  const hasVoice =
    personas.length > 0 && personas.some((p) => !isPlaceholder(p.contentMd));

  const steps: OnboardingStep[] = [
    {
      id: "connect",
      title: "Connect an account",
      description:
        "Pomelo is built in and needs no keys — it is a working social network with a simulated audience, so the whole loop runs offline.",
      href: "/accounts",
      cta: "Connect Pomelo",
      done: hasAccount,
    },
    {
      id: "brief",
      title: "Say who the brand is",
      description:
        "One page: what you build, who it is for, what you never say. Every run reads this first, so a vague brief produces vague posts.",
      href: "/memory",
      cta: "Write the brief",
      done: hasBrief,
    },
    {
      id: "voice",
      title: "Give each account a voice",
      description:
        "A founder account and a company account should not sound alike. The voice card is per-account, and the agent writes a starter one you can edit.",
      href: "/memory",
      cta: "Review the voice",
      done: hasVoice,
    },
    {
      id: "plan",
      title: "Run the first plan",
      description:
        "The agent researches what is moving, then proposes posts per account. Nothing publishes — proposals land in your inbox.",
      href: "/dashboard",
      cta: "Run planning",
      done: (runs?.n ?? 0) > 0,
    },
    {
      id: "review",
      title: "Approve or send one back",
      description:
        "Approving schedules it. Sending it back with a note makes the agent rewrite — review is a conversation, not a veto.",
      href: "/inbox",
      cta: "Open the inbox",
      done: (reviewed?.n ?? 0) > 0,
    },
    {
      id: "watch",
      title: "Watch it land",
      description:
        "Fast-forward a day to publish what is scheduled and let the simulated audience react — replies come back for triage.",
      href: "/pomelo",
      cta: "Open Pomelo",
      done: (published?.n ?? 0) > 0,
    },
  ];

  const doneCount = steps.filter((s) => s.done).length;
  return { complete: doneCount === steps.length, doneCount, steps };
}

/** The starter voice card written when an account is connected. */
export function starterPersona(input: {
  handle: string;
  displayName: string;
  platform: string;
}): string {
  return `# Voice: @${input.handle}
${PLACEHOLDER_MARK}

**Who is speaking:** ${input.displayName} on ${input.platform}.

**Tone:** Plain and specific. Short sentences. No hype words, no emoji walls.

**What this account posts about**
- (Replace these with your real content pillars — the agent uses them to choose topics.)
- Progress on what you are building
- Something you learned the hard way
- A useful opinion about your field

**Never**
- Engagement bait ("Thoughts? 👇")
- Claiming results you cannot show
- Replying to bad-faith comments

**Audience:** People who could actually use what you make.

> This is a starter card so the agent has somewhere to begin. Edit it — the more
> specific it is, the less generic the drafts come back.
`;
}

/**
 * Starter documents are marked rather than guessed at by length, so editing one
 * down to a single sharp line still counts as written.
 */
const PLACEHOLDER_MARK = "<!-- zest:starter -->";

export function isPlaceholder(contentMd: string): boolean {
  return contentMd.includes(PLACEHOLDER_MARK);
}
