import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareVariants,
  planEngagement,
  scoreAffinity,
  scoreQuality,
  seededRandom,
  type SimPersona,
} from "./engine.ts";
import { classifySentiment, composeReply } from "./replier.ts";

function persona(
  id: string,
  interests: string[],
  overrides: Partial<SimPersona["config"]> = {},
): SimPersona {
  return {
    id,
    handle: id,
    followerCount: 1000,
    config: {
      archetype: "enthusiast",
      interests,
      tone: "friendly",
      propensity: 0.8,
      activeHours: [0, 24],
      ...overrides,
    },
  };
}

const AUDIENCE = Array.from({ length: 30 }, (_, i) =>
  persona(`p${i}`, i % 2 === 0 ? ["devtools", "ai"] : ["design", "startup"]),
);

test("the same post always produces the same simulation", () => {
  const input = {
    postId: "post-1",
    text: "We rebuilt our devtools pipeline around ai agents. Here is what broke.",
    publishedAt: new Date("2026-06-01T09:00:00Z"),
    personas: AUDIENCE,
    authorFollowers: 2000,
  };
  const a = planEngagement(input);
  const b = planEngagement(input);
  assert.deepEqual(a.events, b.events, "a replayed demo must tell the same story");
});

test("quality scoring rewards a hook, a question and concrete detail", () => {
  const weak = scoreQuality("update");
  const strong = scoreQuality(
    "We cut our deploy time from 14 minutes to 90 seconds. The fix was not what we expected — what is your slowest step?",
  );
  assert.ok(strong > weak, `expected ${strong} > ${weak}`);
});

test("quality scoring punishes hashtag spam and shouting", () => {
  const clean = scoreQuality("A short note about how we handle retries in the worker.");
  const spammy = scoreQuality(
    "A short note about how we handle retries #dev #code #tech #ai #startup #growth",
  );
  const shouty = scoreQuality("THIS CHANGES EVERYTHING!!! read now!!");
  assert.ok(spammy < clean);
  assert.ok(shouty < clean);
});

test("affinity tracks whether the post matches a persona's interests", () => {
  const devPersona = persona("dev", ["devtools", "open-source"]);
  const matching = scoreAffinity(devPersona, "New devtools release, fully open-source.");
  const unrelated = scoreAffinity(devPersona, "Thoughts on restaurant menu design.");
  assert.ok(matching > unrelated);
  assert.ok(unrelated > 0, "people still see things outside their niche");
});

test("engagement concentrates in the first hours, with a long tail", () => {
  const plan = planEngagement({
    postId: "decay-check",
    text: "A practical guide to devtools and ai agents, with 3 concrete examples.",
    publishedAt: new Date("2026-06-01T09:00:00Z"),
    personas: AUDIENCE,
    authorFollowers: 5000,
  });

  const SIX_HOURS = 6 * 3_600_000;
  const early = plan.events.filter((e) => e.offsetMs <= SIX_HOURS).length;
  assert.ok(plan.events.length > 0, "a matching post should get some engagement");
  assert.ok(
    early / plan.events.length > 0.5,
    `expected most engagement early, got ${early}/${plan.events.length}`,
  );
});

test("reactions are ordered and never precede the post", () => {
  const plan = planEngagement({
    postId: "ordering",
    text: "Shipping notes on our ai agents work.",
    publishedAt: new Date("2026-06-01T09:00:00Z"),
    personas: AUDIENCE,
    authorFollowers: 1000,
  });
  let previous = -1;
  for (const event of plan.events) {
    assert.ok(event.offsetMs >= 0, "no reaction before publication");
    assert.ok(event.offsetMs >= previous, "events must be chronological");
    previous = event.offsetMs;
  }
});

test("every reaction belongs to a persona who saw the post", () => {
  const plan = planEngagement({
    postId: "impression-first",
    text: "Notes on devtools and ai.",
    publishedAt: new Date("2026-06-01T09:00:00Z"),
    personas: AUDIENCE,
    authorFollowers: 1000,
  });
  const sawIt = new Set(
    plan.events.filter((e) => e.kind === "impression").map((e) => e.actorId),
  );
  for (const event of plan.events) {
    assert.ok(
      sawIt.has(event.actorId),
      `${event.actorId} reacted without an impression`,
    );
  }
});

test("a bigger account reaches more people", () => {
  const text = "A note about devtools and ai agents.";
  const small = planEngagement({
    postId: "reach",
    text,
    publishedAt: new Date("2026-06-01T09:00:00Z"),
    personas: AUDIENCE,
    authorFollowers: 20,
  });
  const large = planEngagement({
    postId: "reach",
    text,
    publishedAt: new Date("2026-06-01T09:00:00Z"),
    personas: AUDIENCE,
    authorFollowers: 500_000,
  });
  assert.ok(large.reach >= small.reach, `${large.reach} should be >= ${small.reach}`);
});

test("lurkers rarely reply, question askers often do", () => {
  const lurkers = Array.from({ length: 40 }, (_, i) =>
    persona(`l${i}`, ["devtools"], { archetype: "lurker", propensity: 0.08 }),
  );
  const askers = Array.from({ length: 40 }, (_, i) =>
    persona(`q${i}`, ["devtools"], { archetype: "question_asker", propensity: 0.9 }),
  );
  const text = "A devtools post that invites a question. What would you change?";
  const countReplies = (personas: SimPersona[]) =>
    planEngagement({
      postId: "reply-bias",
      text,
      publishedAt: new Date("2026-06-01T09:00:00Z"),
      personas,
      authorFollowers: 5000,
    }).events.filter((e) => e.kind === "reply").length;

  assert.ok(countReplies(askers) > countReplies(lurkers));
});

test("the wind tunnel ranks variants and stays deterministic", () => {
  const variants = [
    { id: "a", text: "update" },
    {
      id: "b",
      text: "We cut devtools build time by 87%. Here are the 3 changes that mattered — which would you try first?",
    },
  ];
  const first = compareVariants(variants, AUDIENCE, 3000);
  const second = compareVariants(variants, AUDIENCE, 3000);
  assert.deepEqual(
    first.map((v) => v.id),
    second.map((v) => v.id),
  );
  assert.equal(first[0]?.id, "b", "the stronger post should win");
});

test("seeded randomness is reproducible and varies by seed", () => {
  const a = seededRandom("seed-1");
  const b = seededRandom("seed-1");
  const c = seededRandom("seed-2");
  assert.equal(a(), b());
  assert.notEqual(seededRandom("seed-1")(), c());
});

test("template replies stay believable without an LLM key", async () => {
  const text = await composeReply({
    postText: "We rebuilt our scheduling pipeline around postgres.",
    persona: {
      handle: "curious_lee",
      config: {
        archetype: "question_asker",
        interests: ["devtools"],
        tone: "curious",
        propensity: 0.9,
        activeHours: [8, 22],
      },
    },
    seed: "reply-1",
  });
  assert.ok(text.length > 0);
  assert.ok(!text.includes("{topic}"), "placeholders must be filled in");
});

test("sentiment classification separates praise, pushback and abuse", () => {
  assert.equal(classifySentiment("This is great, exactly what I needed"), "positive");
  assert.equal(classifySentiment("This is garbage, you are an idiot"), "hostile");
  assert.equal(classifySentiment("Posting this later today"), "neutral");
});

test("a compliment wrapping a challenge counts as pushback", () => {
  // Otherwise an "auto-reply to positive comments" rule would thank a skeptic
  // for their scepticism.
  assert.equal(classifySentiment("Nice, but what's the catch here?"), "negative");
  assert.equal(classifySentiment("Love the idea, however I'm unconvinced"), "negative");
  assert.equal(classifySentiment("Great write-up — though I've been burned before"), "negative");
});
