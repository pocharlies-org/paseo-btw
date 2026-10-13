import type { PluginServerContext } from "@getpaseo/plugin/server";
import { sideAnswerSoFar, sideQuestion } from "./shared/contract.ts";
import * as ask from "./server/ask.ts";

// Two RPCs and nothing else: the question returns an id at once (Paseo cuts every plugin RPC at 30 s) and the panel asks for what has
// arrived. The bearer of the account is read per call in server/accounts.ts and goes only to the local router.
export default function contribute(server: PluginServerContext) {
  server.handle(sideQuestion, (input, context) => ask.sideQuestion(input, context));
  server.handle(sideAnswerSoFar, (input) => ask.answerSoFar(input));
  return () => {};
}
