import { createScorer } from "@mastra/core/evals";

/**
 * Output hygiene for the copywriter, scored in code — no judge model, no
 * cost, runs on every sampled generation and lands in Studio's Scorers tab.
 *
 * These are the SHARED_VOICE_RULES that can be checked mechanically: a post
 * is not empty, does not open with preamble ("Here's a post:" is the model
 * talking about the work instead of doing it), and does not stuff hashtags.
 * What only a reader can judge — voice, honesty, whether the angle landed —
 * stays with the reader.
 */
export const draftQualityScorer = createScorer({
  id: "draft-quality",
  description:
    "Copywriter output hygiene: not empty, no preamble, no hashtag stuffing.",
  type: "agent",
}).generateScore(({ run }) => {
  const text = textFrom(run.output);
  if (!text.trim()) return 0;

  let score = 1;
  if (/^\s*(here('|’)s|here is|i('|’)ve (written|drafted)|sure[,!])/i.test(text)) {
    score -= 0.5;
  }
  if ((text.match(/#\w+/g) ?? []).length > 2) {
    score -= 0.5;
  }
  return Math.max(score, 0);
});

/** The output arrives as messages-with-parts; the score is about the words. */
function textFrom(output: unknown): string {
  if (!Array.isArray(output)) return "";
  return output
    .flatMap((message) => {
      const parts = (message as { content?: { parts?: { type?: string; text?: string }[] } })
        .content?.parts;
      return parts ?? [];
    })
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}
