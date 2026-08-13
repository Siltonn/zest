import type { PersonaConfig } from "@zest/db/schema";

/**
 * Pomelo's residents.
 *
 * A believable audience is what separates a demo people remember from one that
 * feels like random numbers. Each persona has interests (so engagement tracks
 * what a post is actually about), a tone (so replies read differently from one
 * another), a propensity (so some accounts are chatty and others lurk), and
 * active hours (so a 3am post lands quieter than a 9am one).
 */

export type PersonaSeed = {
  handle: string;
  displayName: string;
  bio: string;
  followerCount: number;
  config: PersonaConfig;
};

const INTERESTS = {
  devtools: ["devtools", "developer-experience", "cli", "open-source"],
  ai: ["ai", "agents", "llm", "automation"],
  startup: ["startup", "founders", "saas", "growth"],
  design: ["design", "ux", "product"],
  infra: ["infrastructure", "databases", "performance", "self-hosting"],
} as const;

/** Deterministic seed data — the same demo every time, which matters live. */
export const PERSONA_SEEDS: PersonaSeed[] = [
  // ── Enthusiasts: amplify, rarely criticise ──────────────────────────────
  persona("maya_builds", "Maya Chen", "Shipping small tools, loudly.", 2400, {
    archetype: "enthusiast",
    interests: [...INTERESTS.devtools, ...INTERESTS.ai],
    tone: "warm, exclamation-prone, quick to boost things she likes",
    propensity: 0.85,
    activeHours: [8, 23],
  }),
  persona("devon_ops", "Devon Reyes", "Platform engineer. Automate everything.", 1800, {
    archetype: "enthusiast",
    interests: [...INTERESTS.infra, ...INTERESTS.devtools],
    tone: "practical enthusiasm, mentions his own setup",
    propensity: 0.7,
    activeHours: [7, 19],
  }),
  persona("priya_ships", "Priya Nair", "Indie hacker. 3 products, 1 cat.", 3100, {
    archetype: "enthusiast",
    interests: [...INTERESTS.startup, ...INTERESTS.devtools],
    tone: "upbeat, shares her own numbers",
    propensity: 0.8,
    activeHours: [9, 22],
  }),
  persona("kofi_dev", "Kofi Mensah", "Backend. Coffee. Repeat.", 940, {
    archetype: "enthusiast",
    interests: [...INTERESTS.infra, ...INTERESTS.ai],
    tone: "short and appreciative",
    propensity: 0.6,
    activeHours: [6, 16],
  }),

  // ── Skeptics: the reason a reply queue is worth having ──────────────────
  persona("realtalk_sam", "Sam Okonkwo", "Ask me why your abstraction leaks.", 5200, {
    archetype: "skeptic",
    interests: [...INTERESTS.ai, ...INTERESTS.devtools],
    tone: "pointed but fair; wants evidence, not adjectives",
    propensity: 0.55,
    activeHours: [10, 23],
  }),
  persona("nina_reviews", "Nina Petrov", "I read the changelog so you don't.", 3800, {
    archetype: "skeptic",
    interests: [...INTERESTS.devtools, ...INTERESTS.infra],
    tone: "dry, specific, occasionally cutting",
    propensity: 0.5,
    activeHours: [11, 21],
  }),
  persona("grumpy_ops", "Hal Brennan", "20 years of on-call. Unimpressed.", 2700, {
    archetype: "skeptic",
    interests: [...INTERESTS.infra, ...INTERESTS.startup],
    tone: "world-weary, likes to point out prior art",
    propensity: 0.4,
    activeHours: [8, 18],
  }),

  // ── Question askers: give the reply agent real work ─────────────────────
  persona("curious_lee", "Lee Zhang", "Learning in public.", 620, {
    archetype: "question_asker",
    interests: [...INTERESTS.devtools, ...INTERESTS.ai],
    tone: "genuinely curious, asks follow-ups",
    propensity: 0.9,
    activeHours: [9, 23],
  }),
  persona("ana_asks", "Ana Ruiz", "PM turned builder. Lots of questions.", 1100, {
    archetype: "question_asker",
    interests: [...INTERESTS.startup, ...INTERESTS.design],
    tone: "thoughtful, asks about trade-offs and pricing",
    propensity: 0.85,
    activeHours: [8, 20],
  }),
  persona("newgrad_tom", "Tom Whitfield", "First dev job. Absorbing everything.", 310, {
    archetype: "question_asker",
    interests: [...INTERESTS.devtools],
    tone: "eager, sometimes asks the obvious thing",
    propensity: 0.75,
    activeHours: [10, 24],
  }),

  // ── Industry peers: credibility signal when they engage ─────────────────
  persona("jules_infra", "Jules Marchand", "Building developer platforms.", 8900, {
    archetype: "industry_peer",
    interests: [...INTERESTS.infra, ...INTERESTS.devtools],
    tone: "measured, technical, comments as an equal",
    propensity: 0.35,
    activeHours: [9, 19],
  }),
  persona("rin_founder", "Rin Takahashi", "Founder. Previously infra at scale.", 12400, {
    archetype: "industry_peer",
    interests: [...INTERESTS.startup, ...INTERESTS.ai],
    tone: "concise, high-signal, rarely gushes",
    propensity: 0.25,
    activeHours: [7, 17],
  }),
  persona("dr_agents", "Dr. Amara Diallo", "Researching agent systems.", 6700, {
    archetype: "industry_peer",
    interests: [...INTERESTS.ai],
    tone: "precise, cites papers, gently corrects",
    propensity: 0.3,
    activeHours: [10, 20],
  }),

  // ── Meme posters: texture, and the odd viral boost ──────────────────────
  persona("yaml_goblin", "yaml goblin", "indentation is a lifestyle", 4400, {
    archetype: "meme_poster",
    interests: [...INTERESTS.infra, ...INTERESTS.devtools],
    tone: "all lowercase, absurdist, one-liners",
    propensity: 0.65,
    activeHours: [13, 26],
  }),
  persona("prod_on_friday", "Deploys On Friday", "chaos agent, affectionate", 5600, {
    archetype: "meme_poster",
    interests: [...INTERESTS.devtools, ...INTERESTS.startup],
    tone: "jokey, riffs on the post rather than engaging with it",
    propensity: 0.7,
    activeHours: [12, 25],
  }),

  // ── Lurkers: impressions without noise, like the real thing ─────────────
  ...Array.from({ length: 20 }, (_, i) =>
    persona(
      `reader_${String(i + 1).padStart(2, "0")}`,
      `Reader ${i + 1}`,
      "Mostly here to read.",
      50 + i * 37,
      {
        archetype: "lurker",
        interests: Object.values(INTERESTS)[i % 5] as unknown as string[],
        tone: "rarely speaks; when they do, it is brief",
        propensity: 0.08,
        activeHours: [(6 + i) % 24, (6 + i + 12) % 24],
      },
    ),
  ),
];

function persona(
  handle: string,
  displayName: string,
  bio: string,
  followerCount: number,
  config: PersonaConfig,
): PersonaSeed {
  return { handle, displayName, bio, followerCount, config };
}

/** Deterministic avatars, no network fetch at seed time. */
export function avatarFor(handle: string): string {
  return `https://api.dicebear.com/9.x/thumbs/svg?seed=${encodeURIComponent(handle)}`;
}

export const TREND_SEEDS = [
  { topic: "self-hosted AI", momentum: 82 },
  { topic: "agent evals", momentum: 71 },
  { topic: "postgres as a queue", momentum: 64 },
  { topic: "local-first tooling", momentum: 58 },
  { topic: "shipping on Fridays", momentum: 43 },
  { topic: "open-source sustainability", momentum: 39 },
];
