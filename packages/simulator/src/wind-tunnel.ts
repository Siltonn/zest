import { eq, schema, type Database } from "@zest/db";
import { compareVariants, type SimPersona } from "./engine.ts";
import { loadPersonas } from "./service.ts";

/**
 * The content wind tunnel.
 *
 * Pomelo's audience is real software, so it can be used for something no other
 * scheduler can offer: try two or three versions of a post against the same
 * simulated readers, with the same seed, and see which one travels — before
 * anything reaches a live account.
 *
 * It is not a prediction of how the real world will react; it is a comparison
 * under controlled conditions, which is a more honest claim and a more useful
 * one. The differences it surfaces come from the writing, because everything
 * else is held constant.
 */

export type Variant = { id: string; text: string };

export type VariantResult = {
  id: string;
  text: string;
  /** Interactions per impression, on the simulated audience. */
  score: number;
  impressions: number;
  likes: number;
  reposts: number;
  replies: number;
  /** The content-quality heuristic, so a weak score is explainable. */
  quality: number;
  /** Which personas engaged most, so "who is this for" is visible. */
  topArchetypes: string[];
};

export type WindTunnelReport = {
  variants: VariantResult[];
  winner: VariantResult | null;
  /** Present when the gap is too small to call. */
  inconclusive?: string;
};

export async function runWindTunnel(
  db: Database,
  input: { variants: Variant[]; accountId: string },
): Promise<WindTunnelReport> {
  if (input.variants.length < 2) {
    throw new Error("A wind tunnel run needs at least two variants to compare");
  }

  const [account] = await db
    .select()
    .from(schema.linkedAccounts)
    .where(eq(schema.linkedAccounts.id, input.accountId));
  if (!account) throw new Error("Unknown account");

  const [pomeloUser] = account.externalId
    ? await db
        .select()
        .from(schema.pomeloUsers)
        .where(eq(schema.pomeloUsers.id, account.externalId))
    : [];

  const personas = await loadPersonas(db);
  const followers = pomeloUser?.followerCount ?? 500;

  const ranked = compareVariants(input.variants, personas, followers);

  const results: VariantResult[] = ranked.map((entry) => {
    const events = entry.plan.events;
    const count = (kind: string) => events.filter((e) => e.kind === kind).length;

    return {
      id: entry.id,
      text: entry.text,
      score: entry.score,
      impressions: count("impression"),
      likes: count("like"),
      reposts: count("repost"),
      replies: count("reply"),
      quality: entry.plan.quality,
      topArchetypes: dominantArchetypes(events, personas),
    };
  });

  const [first, second] = results;
  if (!first) return { variants: results, winner: null };

  // A hair's difference on a simulated audience is not a finding. Saying so is
  // more useful than declaring a winner the numbers do not support.
  const margin = second ? first.score - second.score : 1;
  if (second && margin < 0.02) {
    return {
      variants: results,
      winner: null,
      inconclusive:
        "These perform about the same with this audience. Pick the one you prefer, or try a sharper difference between them.",
    };
  }

  return { variants: results, winner: first };
}

function dominantArchetypes(
  events: { kind: string; actorId: string }[],
  personas: SimPersona[],
): string[] {
  const byId = new Map(personas.map((p) => [p.id, p.config.archetype]));
  const counts = new Map<string, number>();

  for (const event of events) {
    if (event.kind === "impression") continue;
    const archetype = byId.get(event.actorId);
    if (!archetype) continue;
    counts.set(archetype, (counts.get(archetype) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([archetype]) => archetype.replace(/_/g, " "));
}
