import { readFile } from "node:fs/promises";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { applyEvent, readEvents, transcriptMessages, withQuestion, type Answer } from "../shared/ask.ts";
import { AskError, FAILURE_TEXT, route } from "./route.ts";
import * as http from "./http.ts";
import { locate } from "./transcripts.ts";

// The answer streams, so the deadline is silence: this long without a byte from LiteLLM and it is given up.
const IDLE_MS = 120_000;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_TOKENS = 2_048;
// An ended answer waits this long for the panel to read its last piece, then it is forgotten.
const KEEP_MS = 10 * 60_000;
// LiteLLM sends Claude models with an account's OAuth bearer, which reaches Opus and Sonnet only as Claude Code: without this block
// Anthropic answers 429 `rate_limit_error` "Error".
const SYSTEM = [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }];

/** What a side question costs: the session's context since its last compaction, no tools, and the question with its reminder. */
export function askBody(lines: string[], model: string | null | undefined, question: string): string {
  const { messages, model: echoed } = transcriptMessages(lines);
  // `model` is the one picked in the panel or the agent's, the name LiteLLM knows; the transcript carries the name the API echoed, which for
  // a non-Claude model is not routable. Paseo marks the 1M window as `[1m]`, which the API does not take, and the capped context fits without it.
  const name = (model ?? echoed ?? "claude-sonnet-4-5").replace(/\[[^\]]*\]$/, "");
  return JSON.stringify({ model: name, max_tokens: MAX_TOKENS, stream: true, system: SYSTEM, tools: [], messages: withQuestion(messages, question) });
}

type Job = Answer & { done: boolean; error?: string; endedAt?: number };
// The answers being written or waiting to be read, by id. Paseo cuts every plugin RPC at 30 s, so the question returns an id at once and
// the panel asks for what has arrived.
const jobs = new Map<string, Job>();
let lastJob = 0;

function sweep() {
  const old = Date.now() - KEEP_MS;
  for (const [id, job] of jobs) if (job.endedAt !== undefined && job.endedAt < old) jobs.delete(id);
}

/**
 * Starts the answer to `question` from the context of the agent's session and returns its id: one streamed call with `tools: []`, the
 * transcript since its last compaction and the question wrapped in Claude Code's reminder, with the model picked in the panel or the
 * agent's. The session gets nothing: no message, no turn, no fork.
 */
export async function sideQuestion(
  { agentId, question, model }: { agentId: string; question: string; model?: string },
  { paseo }: PluginHandlerContext,
) {
  let body: string;
  try {
    // Everything that locates and reads the session, so that a failure here is one of the fixed texts and never a Node error with a path.
    const { entries } = await paseo.agents.list({ page: { limit: 200 } });
    const agent = entries.find(({ agent }) => agent.id === agentId)?.agent;
    const sessionId = (agent as { persistence?: { sessionId?: string } } | undefined)?.persistence?.sessionId;
    if (!sessionId) throw new AskError("no-session");
    const found = await locate(sessionId);
    if (!found) throw new AskError("no-transcript");
    body = askBody((await readFile(found, "utf8")).split("\n"), model ?? agent?.model, question);
  } catch (error) {
    if (error instanceof AskError) throw error;
    throw new AskError("unreadable");
  }

  const to = await route();
  sweep();
  const id = String(++lastJob);
  const job: Job = { text: "", model: "", done: false };
  jobs.set(id, job);
  void write(job, to, body);
  return { id };
}

/** Writes the streamed answer into its job as it arrives, and how it ended. Never throws: every end is one of the fixed texts. */
async function write(job: Job, to: { url: URL; key: string }, body: string) {
  let pending = "";
  try {
    const headers = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      authorization: `Bearer ${to.key}`,
      "content-length": String(Buffer.byteLength(body)),
    };
    const status = await http.stream(to.url, "/v1/messages", headers, body, IDLE_MS, MAX_BYTES, (text) => {
      const { events, rest } = readEvents(pending + text);
      pending = rest;
      for (const event of events) applyEvent(job, event);
    });
    if (status === 400 || status === 413) job.error = FAILURE_TEXT["too-big"];
    else if (status !== 200) job.error = FAILURE_TEXT.refused;
    else if (job.failed) job.error = FAILURE_TEXT.lost;
  } catch {
    job.error = FAILURE_TEXT[job.text ? "lost" : "router"];
  }
  job.done = true;
  job.endedAt = Date.now();
}

/** An answer as far as it has come: the text after `from` characters, and once it ended, how. */
export function answerSoFar({ id, from }: { id: string; from: number }) {
  sweep();
  const job = jobs.get(id);
  if (!job) throw new AskError("lost");
  return { text: job.text.slice(from), done: job.done, error: job.error, tool: job.tool, model: job.model };
}
