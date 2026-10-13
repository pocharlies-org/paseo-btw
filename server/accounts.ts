import { readFile } from "node:fs/promises";
import * as http from "./http.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { accountId } from "../shared/contract.ts";

// The bearer of the account that owns a session, read from the accounts store of this machine (contract file.claude-cuentas.v1, owned
// by claude-account-switcher's service: this plugin only reads it). Nothing here is kept: a restarted service has a new bearer.

export class AskError extends Error {
  constructor(kind: keyof typeof FAILURE_TEXT) {
    super(FAILURE_TEXT[kind]);
  }
}

/** Why a side question could not be asked. Fixed texts: they travel to the screen and the log, so never a URL, a path or a token. */
export const FAILURE_TEXT = {
  "no-session": "this agent has no Claude session to ask about",
  "no-transcript": "the session's transcript is not on this machine",
  "no-account": "the session's account is not one of the accounts on this machine",
  unreadable: "the session or its account could not be read on this machine",
  router: "the local router did not answer",
  "too-big": "the context of the session does not fit the model's window; ask in the conversation instead",
  refused: "the router refused the question",
  lost: "the answer was lost on the way; ask again",
} as const;

const accountsDir = () => process.env.CLAUDE_CUENTAS_DIR || join(homedir(), ".config/claude-cuentas");

const discoverySchema = z.object({ v: z.literal(1), url: z.string(), token: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/) });
// Contract claude-account-switcher.service.discovery.v1: the bearer goes only to http://127.0.0.1:<port> or http://localhost:<port>.
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost):([0-9]{1,5})$/;

/** Which account the service considers effective (or preferred): the one that owns a session of the plugin's `claude` provider. */
async function effective(): Promise<string> {
  let answer: { status: number; text: string };
  try {
    const found = discoverySchema.parse(JSON.parse(await readFile(join(accountsDir(), "service.json"), "utf8")));
    const url = LOOPBACK.exec(found.url);
    if (!url) throw new Error("not loopback");
    answer = await http.send(
      { host: url[1], port: Number(url[2]) },
      "GET",
      "/v1/state",
      { authorization: `Bearer ${found.token}`, accept: "application/json" },
      undefined,
      5_000,
      1024 * 1024,
    );
  } catch {
    throw new AskError("unreadable"); // no service answering is not the same as an account with no id
  }
  if (answer.status !== 200) throw new AskError("unreadable");
  const state = z.object({ effective: accountId.nullable(), config: z.object({ preferred: accountId.nullable() }) }).parse(JSON.parse(answer.text));
  const id = state.effective ?? state.config.preferred;
  if (id === null) throw new AskError("no-account");
  return id;
}

/**
 * The account that owns a transcript: the provider's `CLAUDE_CONFIG_DIR` is the account's `configDir` (contract file.claude-cuentas.v1).
 * The provider without a directory of its own is the plugin's `claude`, which uses whichever account the service has effective.
 */
export async function accountOf(configDir: string | null): Promise<string> {
  if (configDir === null) return effective();
  const accounts = JSON.parse(await readFile(join(accountsDir(), "accounts.json"), "utf8").catch(() => '{"accounts":[]}'));
  const found = accounts.accounts.find((a: any) => a?.configDir === configDir);
  if (typeof found?.id !== "string") throw new AskError("no-account");
  return found.id;
}

/** The bearer of an account, read on every call and never kept. The id is checked against the id rule before the path is built. */
export async function token(account: string): Promise<string> {
  const parsed = accountId.safeParse(account);
  if (!parsed.success) throw new AskError("no-account");
  const text = await readFile(join(accountsDir(), `${parsed.data}.token`), "utf8").catch(() => null);
  if (text === null) throw new AskError("no-account");
  return text.trim();
}
