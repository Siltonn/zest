/**
 * Scripted models for the per-agent tests.
 *
 * The repo's test culture is real Postgres and no mocks — what gets scripted
 * here is only the one thing a test cannot own: the model's reply. Each turn
 * is consumed in order, so a stage that runs "tool call, then closing text"
 * is two turns, and the assertions run against everything real underneath —
 * the tools, the domain services, the run bookkeeping, the database.
 *
 * A hand-rolled LanguageModelV2 rather than `ai/test`'s MockLanguageModelV2,
 * because that helper's barrel drags in `msw` — a whole mock-service-worker
 * stack for thirty lines of spec object.
 *
 * Injected through `options.model`, which rides the request context into the
 * agent's dynamic model — no provider key involved, nothing on the network.
 */

type Usage = { inputTokens: number; outputTokens: number; totalTokens: number };
const usage: Usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

type Reply = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool-call"; toolCallId: string; toolName: string; input: string }
  >;
  finishReason: "stop" | "tool-calls";
  usage: Usage;
  warnings: [];
};

type Turn = Reply | { throws: string };

let callId = 0;

/** A turn that dies instead of answering — for containment assertions. */
export function throwingTurn(message: string): Turn {
  return { throws: message };
}

/** A closing prose turn. */
export function textTurn(text: string): Turn {
  return { content: [{ type: "text", text }], finishReason: "stop", usage, warnings: [] };
}

/** One tool invocation; the real tool executes against the real database. */
export function toolTurn(toolName: string, input: unknown): Turn {
  callId += 1;
  return {
    content: [
      {
        type: "tool-call",
        toolCallId: `scripted-${callId}`,
        toolName,
        input: JSON.stringify(input),
      },
    ],
    finishReason: "tool-calls",
    usage,
    warnings: [],
  };
}

export type ScriptedModel = {
  specificationVersion: "v2";
  provider: string;
  modelId: string;
  supportedUrls: Record<string, RegExp[]>;
  /** Every prompt the agent sent, for asserting what the model actually saw. */
  calls: { prompt: unknown }[];
  doGenerate(options: { prompt: unknown }): Promise<Reply>;
  doStream(): never;
};

export function scriptedModel(modelId: string, turns: Turn[]): ScriptedModel {
  let next = 0;
  const model: ScriptedModel = {
    specificationVersion: "v2",
    provider: "scripted",
    modelId,
    supportedUrls: {},
    calls: [],
    async doGenerate(options) {
      model.calls.push({ prompt: options.prompt });
      const turn = turns[next];
      if (!turn) {
        throw new Error(
          `${modelId} was asked for turn ${next + 1} but only ${turns.length} were scripted`,
        );
      }
      next += 1;
      if ("throws" in turn) throw new Error(turn.throws);
      return turn;
    },
    doStream() {
      throw new Error("scripted models do not stream");
    },
  };
  return model;
}

/** A model that dies mid-run, for the failure-path guarantees. */
export function failingModel(modelId: string, message: string): ScriptedModel {
  const model = scriptedModel(modelId, []);
  model.doGenerate = async () => {
    throw new Error(message);
  };
  return model;
}
