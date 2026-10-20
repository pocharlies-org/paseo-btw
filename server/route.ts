import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Where a side question goes: LiteLLM, with the URL and key of Paseo's `claude` provider, the same route its sessions
// take; LiteLLM picks the Claude account. The key is read on every call and never kept.

export class AskError extends Error {
  constructor(kind: keyof typeof FAILURE_TEXT) {
    super(FAILURE_TEXT[kind]);
  }
}

/** Why a side question could not be asked. Fixed texts: they travel to the screen and the log, so never a URL, a path or a token. */
export const FAILURE_TEXT = {
  "no-session": "this agent has no Claude session to ask about",
  "no-transcript": "the session's transcript is not on this machine",
  "no-route": "Paseo's claude provider has no LiteLLM route on this machine",
  unreadable: "the session could not be read on this machine",
  router: "LiteLLM did not answer",
  "too-big": "the context of the session does not fit the model's window; ask in the conversation instead",
  refused: "LiteLLM refused the question",
  lost: "the answer was lost on the way; ask again",
} as const;

// The key goes only over https, or over http to loopback.
const ALLOWED = /^(https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?|http:\/\/(127\.0\.0\.1|localhost)(:[0-9]{1,5})?)\/?$/;

/** The base URL and key of the `claude` provider in `~/.paseo/config.json` (`PASEO_HOME`). */
export async function route(): Promise<{ url: URL; key: string }> {
  try {
    const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
    const env = JSON.parse(await readFile(join(home, "config.json"), "utf8"))?.agents?.providers?.claude?.env ?? {};
    const { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: key } = env;
    if (typeof base === "string" && ALLOWED.test(base) && typeof key === "string" && key) return { url: new URL(base), key };
  } catch {
    // an unreadable config is the same as no route
  }
  throw new AskError("no-route");
}
