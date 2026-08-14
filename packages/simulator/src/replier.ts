import type { PersonaConfig } from "@zest/db/schema";
import { seededRandom } from "./engine.ts";

/**
 * What Pomelo residents actually say.
 *
 * With an LLM key available the caller passes `generate` and each reply is
 * written in the persona's voice. Without one we fall back to archetype
 * template banks — because the whole promise is that the loop runs with zero
 * keys, and an audience that only says "Nice post!" would make the reply-triage
 * step look pointless. The templates therefore include real questions and mild
 * criticism, which is what gives the agent something to triage.
 */

export type ReplyRequest = {
  postText: string;
  persona: { handle: string; config: PersonaConfig };
  seed: string;
};

export type ReplyGenerator = (request: ReplyRequest) => Promise<string>;

const TEMPLATES: Record<PersonaConfig["archetype"], string[]> = {
  enthusiast: [
    "This is exactly the thing I've been waiting for. Adding it to my stack this week.",
    "Okay this is genuinely great. Been fighting this problem all month.",
    "Love this. The part about {topic} especially — that's the bit everyone skips.",
    "Saved. I'm going to try this on the side project tonight.",
  ],
  skeptic: [
    "How is this different from what already exists? Genuine question, not a dunk.",
    "I want to believe, but what happens when {topic} gets big? Does this still hold?",
    "Reasonable, though I've been burned by this exact promise before. What's the catch?",
    "The claim is strong. Any numbers behind it, or is this still aspirational?",
  ],
  question_asker: [
    "This looks useful — does it work if you're self-hosting?",
    "Quick question: how does this handle the case where {topic} fails halfway through?",
    "Is there a free tier, or is this paid from the start?",
    "How long did this take you to build? Trying to scope something similar.",
  ],
  industry_peer: [
    "Solid approach. We went a similar route and the tricky part was {topic}.",
    "Nice. Curious how you handled the state between runs.",
    "This matches what we saw in production. The trade-off is worth naming explicitly.",
  ],
  meme_poster: [
    "ah yes, {topic}. my beloved.",
    "posting this in the team channel with no context",
    "me, reading this at 2am instead of sleeping: fascinating",
    "finally someone said it",
  ],
  lurker: ["Useful, thanks.", "Bookmarking this.", "Good thread."],
};

/** Pulls a noun from the post so template replies feel responsive. */
function extractTopic(postText: string, fallback: string): string {
  const hashtag = postText.match(/#(\w+)/)?.[1];
  if (hashtag) return hashtag;

  const words = postText
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 5 && !STOPWORDS.has(w));

  return words[0] ?? fallback;
}

const STOPWORDS = new Set([
  "because",
  "through",
  "should",
  "without",
  "another",
  "between",
  "really",
  "always",
  "something",
  "everything",
]);

export async function composeReply(
  request: ReplyRequest,
  generate?: ReplyGenerator,
): Promise<string> {
  if (generate) {
    try {
      const text = await generate(request);
      if (text.trim().length > 0) return text.trim();
    } catch {
      // A rate limit or a missing key must not stop the simulation; fall
      // through to templates so the demo keeps moving.
    }
  }

  const bank = TEMPLATES[request.persona.config.archetype];
  const random = seededRandom(request.seed);
  const template = bank[Math.floor(random() * bank.length)] ?? bank[0] ?? "Interesting.";
  const topic = extractTopic(
    request.postText,
    request.persona.config.interests[0] ?? "this",
  );
  return template.replace(/\{topic\}/g, topic);
}

/**
 * Classifies a reply so the agent's triage step has something to act on, and
 * so autonomy rules like "auto-answer positive comments only" can work.
 */
/**
 * Triage sentiment.
 *
 * This drives real behaviour: an auto-reply rule can be scoped to friendly
 * comments, so mislabelling decides whether a skeptic gets a cheerful
 * thank-you. Two failures showed up against real generated replies —
 *
 *   "That's an interesting trade-off, but how do you think the cost compares?"
 *      → read as negative, because of one "but". It is a question.
 *   "Yeah, because skipping locks is a well-known tradeoff. Did you actually
 *    expect throughput to stay the same?"
 *      → read as neutral, because sarcasm uses no negative words at all.
 *
 * So a soft contrast only counts as pushback when the message is not primarily
 * a question, and the sarcastic openers that carry real hostility are matched
 * directly.
 */
export function classifySentiment(
  text: string,
): "positive" | "neutral" | "negative" | "hostile" {
  const lower = text.toLowerCase();

  if (/\b(garbage|useless|scam|shut up|idiot|stupid)\b/.test(lower)) return "hostile";

  // Sarcasm wearing a neutral vocabulary. Rhetorical, not curious.
  const sarcastic =
    /\byeah,?\s+(because|sure|right)\b/.test(lower) ||
    /\bdid you (actually|really|seriously)\b/.test(lower) ||
    /\b(oh|wow),?\s+(great|cool|amazing)\b/.test(lower);

  // Unambiguous pushback: the words mean doubt regardless of punctuation.
  const strongPushback =
    /\b(catch|burned|doubt|doubtful|skeptic|skeptical|overhyped|disagree|unconvinced|nonsense|hype)\b/.test(
      lower,
    ) || /\breally\?/.test(lower);

  // A message whose weight is a question. "X, but how does Y work?" is someone
  // asking, and answering it defensively is the failure this avoids.
  const asksSomething =
    /\?/.test(text) &&
    /\b(how|what|why|when|where|which|who|does|do|is|are|can|could|would|any)\b/.test(
      lower,
    );

  const softContrast = /\b(but|however|though)\b/.test(lower);

  if (sarcastic || strongPushback) return "negative";
  if (softContrast && !asksSomething) return "negative";

  // Praise does not promote a question. "Nice work — does this handle clock
  // drift?" is friendly and still needs an actual answer, and `positive` is the
  // bucket an auto-reply rule is most likely to be pointed at. Leaving it
  // neutral means the question reaches someone who will answer it.
  if (asksSomething) return "neutral";

  if (
    /\b(love|great|excellent|exactly|brilliant|useful|saved|awesome|nice)\b/.test(lower)
  ) {
    return "positive";
  }

  return "neutral";
}
