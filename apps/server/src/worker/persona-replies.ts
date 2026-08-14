import { generateText } from "ai";
import { hasModelAccess, resolveCheapModel } from "@zest/agent";
import type { ReplyGenerator } from "@zest/simulator";

/**
 * LLM-backed persona replies for the simulated audience.
 *
 * The simulator has carried a `generateReply` seam since M1, and nothing ever
 * supplied it — so persona replies were always templates, key or no key. This
 * is the half of "with a key, replies come from a cheap model in the persona's
 * voice" that the design promised and the code skipped.
 *
 * Built here rather than inside the simulator because the dependency points the
 * other way: agent depends on simulator, so simulator cannot resolve models.
 * The worker owns both and passes the function in.
 *
 * Uses the cheap tier on purpose: this is high-volume fake audience chatter,
 * and burning flagship tokens on it is how a demo gets expensive. composeReply
 * falls back to templates on any error, so a rate limit or a bad key degrades
 * to the zero-key behaviour instead of stopping the simulation.
 */
export function buildPersonaReplyGenerator(): ReplyGenerator | undefined {
  if (!hasModelAccess()) return undefined;

  return async (request) => {
    const { text } = await generateText({
      model: resolveCheapModel(),
      maxOutputTokens: 120,
      prompt: [
        `You are @${request.persona.handle}, a member of a small social network.`,
        `Archetype: ${request.persona.config.archetype}. Interests: ${request.persona.config.interests.join(", ")}.`,
        `Tone: ${request.persona.config.tone}.`,
        "",
        `Reply to this post in one or two short sentences, in character:`,
        `"${request.postText}"`,
        "",
        "Sound like a person scrolling, not a marketer. No hashtags, no emoji",
        "unless the tone calls for it, and never mention being an AI or a persona.",
        "Skeptics stay skeptical; questioners ask a real question.",
      ].join("\n"),
    });
    return text;
  };
}
