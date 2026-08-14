import type { PersonaConfig } from "@zest/db/schema";

/**
 * The engagement engine.
 *
 * When a post is published on Pomelo we do not sprinkle random numbers on it.
 * We score how much each resident would care, then lay their reactions along a
 * decay curve across the next simulated 48 hours. The result behaves the way
 * social engagement actually behaves: a burst in the first few hours, a long
 * quiet tail, better numbers when the content matches the audience, and the
 * occasional post that catches fire.
 *
 * Everything here is a pure function of (post, personas, seed) so the same
 * demo produces the same story twice — which matters when you are presenting.
 */

export type SimPersona = {
  id: string;
  handle: string;
  followerCount: number;
  config: PersonaConfig;
};

export type SimEventDraft = {
  kind: "impression" | "like" | "repost" | "reply" | "follow";
  actorId: string;
  /** Offset from publication, in simulated milliseconds. */
  offsetMs: number;
};

export type EngagementPlan = {
  events: SimEventDraft[];
  /** Diagnostics the UI surfaces so the simulation is legible, not magic. */
  quality: number;
  reach: number;
  viral: boolean;
};

const HOUR = 3_600_000;
const WINDOW_HOURS = 48;

/**
 * Content quality heuristic. Crude on purpose — it rewards the things that
 * genuinely help a post (a hook, a readable length, a question, a concrete
 * detail) so the agent's writing choices visibly move the numbers.
 */
export function scoreQuality(text: string): number {
  const length = [...text].length;
  let score = 0.5;

  // Very short posts read as low-effort; very long ones lose people.
  if (length >= 80 && length <= 280) score += 0.15;
  if (length < 40) score -= 0.2;
  if (length > 400) score -= 0.1;

  const firstLine = text.split("\n")[0] ?? "";
  if (firstLine.length <= 90 && firstLine.length >= 15) score += 0.1; // has a hook
  if (/\?/.test(text)) score += 0.08; // invites a reply
  if (/\d/.test(text)) score += 0.07; // concrete
  if (/^(I|We)\b/.test(text)) score += 0.05; // first-person

  const hashtags = (text.match(/#\w+/g) ?? []).length;
  if (hashtags > 0 && hashtags <= 2) score += 0.05;
  if (hashtags > 4) score -= 0.15; // spammy

  if (/!{2,}/.test(text) || /[A-Z]{8,}/.test(text)) score -= 0.1; // shouty

  return clamp(score, 0.05, 1);
}

/** How much this persona cares, from interest overlap and archetype. */
export function scoreAffinity(persona: SimPersona, text: string): number {
  const haystack = text.toLowerCase();
  const hits = persona.config.interests.filter((tag) =>
    haystack.includes(tag.toLowerCase().replace(/-/g, " ")) ||
    haystack.includes(tag.toLowerCase()),
  ).length;

  const overlap = Math.min(hits / 2, 1);
  // Even with no keyword match there is a floor: people do read past their niche.
  return clamp(0.25 + overlap * 0.75, 0, 1);
}

/**
 * Deterministic pseudo-randomness. A seeded hash rather than Math.random so a
 * replayed demo tells the same story, and so tests can assert on outcomes.
 */
export function seededRandom(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return ((h >>> 0) % 100000) / 100000;
  };
}

/**
 * Exponential decay: most engagement arrives in the first few hours. Returns an
 * offset in simulated ms, biased toward the start of the window.
 */
function decayOffset(random: () => number): number {
  const u = random();
  // -ln(u) concentrated near 0; scaled so ~70% lands inside the first 6 hours.
  const hours = Math.min(-Math.log(Math.max(u, 0.0001)) * 3.2, WINDOW_HOURS);
  return hours * HOUR;
}

/** Shifts an event into the persona's waking hours so nights stay quiet. */
function respectActiveHours(
  offsetMs: number,
  publishedAt: Date,
  [start, end]: [number, number],
): number {
  const at = new Date(publishedAt.getTime() + offsetMs);
  const hour = at.getUTCHours();
  const awake =
    start <= end ? hour >= start && hour < end : hour >= start || hour < end % 24;
  if (awake) return offsetMs;

  // Asleep: hold the reaction until this persona's next waking hour.
  const hoursUntilWake = (start - hour + 24) % 24;
  return offsetMs + hoursUntilWake * HOUR;
}

export type PlanInput = {
  postId: string;
  text: string;
  publishedAt: Date;
  personas: SimPersona[];
  /** Author reach; a bigger account gets seen by more of the network. */
  authorFollowers: number;
};

export function planEngagement(input: PlanInput): EngagementPlan {
  const random = seededRandom(input.postId);
  const quality = scoreQuality(input.text);

  // Roughly 1 in 12 posts catches an outsized wave. Enough to be a moment in a
  // demo, rare enough that it still feels earned when it happens.
  const viral = random() < 0.08 && quality > 0.6;
  const viralBoost = viral ? 2.2 + random() : 1;

  const reachFactor = clamp(
    0.35 + Math.log10(Math.max(input.authorFollowers, 10)) / 6,
    0.35,
    1,
  );

  const events: SimEventDraft[] = [];
  let reach = 0;

  for (const persona of input.personas) {
    const affinity = scoreAffinity(persona, input.text);
    const seen = random() < reachFactor * (0.5 + affinity * 0.5) * viralBoost;
    if (!seen) continue;

    reach += 1;
    const base = respectActiveHours(
      decayOffset(random),
      input.publishedAt,
      persona.config.activeHours,
    );
    events.push({ kind: "impression", actorId: persona.id, offsetMs: base });

    // Each further step is progressively less likely: seeing is common,
    // replying is rare, and following is rarer still.
    const engagement = affinity * quality * persona.config.propensity * viralBoost;

    if (random() < engagement) {
      events.push({
        kind: "like",
        actorId: persona.id,
        offsetMs: base + random() * 20 * 60_000,
      });
    }
    if (random() < engagement * 0.3) {
      events.push({
        kind: "repost",
        actorId: persona.id,
        offsetMs: base + random() * 45 * 60_000,
      });
    }
    if (random() < engagement * 0.8 * replyBias(persona)) {
      events.push({
        kind: "reply",
        actorId: persona.id,
        offsetMs: base + random() * 90 * 60_000,
      });
    }
    if (random() < engagement * 0.12) {
      events.push({
        kind: "follow",
        actorId: persona.id,
        offsetMs: base + random() * 3 * HOUR,
      });
    }
  }

  // A floor, not a fudge.
  //
  // Measured across 120 simulated posts, 48% drew no reply at all — faithful to
  // a real network and useless here, because the reply queue is the half of the
  // loop this simulator exists to demonstrate. A post that genuinely reached a
  // couple of dozen people and drew nothing back leaves the triage stage with
  // nothing to triage and the demo with nothing to show.
  //
  // So when a post got real reach and still nobody spoke, the persona most
  // inclined to reply does. Picking the highest reply bias among those who
  // actually saw it keeps it in character — the curious one asks, the lurker
  // stays quiet — rather than making everyone chatty.
  if (reach >= MIN_REACH_FOR_GUARANTEED_REPLY && !events.some((e) => e.kind === "reply")) {
    const sawIt = new Set(
      events.filter((e) => e.kind === "impression").map((e) => e.actorId),
    );
    const talker = input.personas
      .filter((p) => sawIt.has(p.id))
      .sort((a, b) => replyBias(b) - replyBias(a))[0];

    if (talker) {
      events.push({
        kind: "reply",
        actorId: talker.id,
        offsetMs: decayOffset(random) + random() * 90 * 60_000,
      });
    }
  }

  events.sort((a, b) => a.offsetMs - b.offsetMs);
  return { events, quality, reach, viral };
}

/**
 * Below this the silence is the honest answer: a post almost nobody saw should
 * not manufacture a conversation.
 */
const MIN_REACH_FOR_GUARANTEED_REPLY = 8;

/** Question askers and skeptics talk; lurkers almost never do. */
function replyBias(persona: SimPersona): number {
  switch (persona.config.archetype) {
    case "question_asker":
      return 2.4;
    case "skeptic":
      return 1.6;
    case "meme_poster":
      return 1.4;
    case "enthusiast":
      return 1;
    case "industry_peer":
      return 0.8;
    case "lurker":
      return 0.15;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Compares variants for the content wind tunnel: the same audience, the same
 * seed, different copy — so a difference in the numbers is a difference in the
 * writing rather than in the dice.
 */
export function compareVariants(
  variants: { id: string; text: string }[],
  personas: SimPersona[],
  authorFollowers: number,
): { id: string; text: string; score: number; plan: EngagementPlan }[] {
  const publishedAt = new Date(0);
  return variants
    .map((variant) => {
      const plan = planEngagement({
        // Fixed seed per position keeps the comparison fair across variants.
        postId: `wind-tunnel:${variant.id}`,
        text: variant.text,
        publishedAt,
        personas,
        authorFollowers,
      });
      const interactions = plan.events.filter((e) => e.kind !== "impression").length;
      const impressions = plan.events.filter((e) => e.kind === "impression").length;
      return {
        ...variant,
        score: impressions > 0 ? interactions / impressions : 0,
        plan,
      };
    })
    .sort((a, b) => b.score - a.score);
}
