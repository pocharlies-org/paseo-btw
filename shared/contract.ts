import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// The contract between this plugin's panel and its server half.
// CONTRACT: rpc.paseo-btw.side-question.v1 — `agent.side-question` and `agent.side-question.poll` are the only way the panel asks;
// a new shape enters as `.v2` and the old name keeps answering.

/** Starts the answer to a side question from the context of an agent's session and returns its id: Paseo cuts every plugin RPC at 30 s. */
export const sideQuestion = defineRpc({
  name: "agent.side-question",
  input: z
    .object({ agentId: z.string().min(1).max(64), question: z.string().trim().min(1).max(4_000), model: z.string().regex(/^[\w.:/@[\]-]{1,100}$/).optional() })
    .strict(),
  output: z.object({ id: z.string() }),
});

/** An answer as far as it has come: the text after `from` characters and, once it ended, how. The panel asks again until `done`. */
export const sideAnswerSoFar = defineRpc({
  name: "agent.side-question.poll",
  input: z.object({ id: z.string().min(1).max(32), from: z.number().int().min(0) }).strict(),
  output: z.object({ text: z.string(), done: z.boolean(), error: z.string().optional(), tool: z.string().optional(), model: z.string() }),
});
