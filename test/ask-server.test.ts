import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { accountOf } from "../server/accounts.ts";
import { answerSoFar, askBody } from "../server/ask.ts";
import { stream } from "../server/http.ts";

// The two decisions `server/ask.ts` takes before any network is involved: whose token to read, and what to send. The transport is the one
// helper of `server/http.ts`, covered against the real service by integration.test.ts.
const made: string[] = [];

function accountsDir(accounts: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "ask-accounts-"));
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, "accounts.json"), JSON.stringify({ accounts }));
  process.env.CLAUDE_CUENTAS_DIR = dir;
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.CLAUDE_CUENTAS_DIR;
});

describe("whose account a session belongs to", () => {
  const accounts = [
    { id: "edani", label: "E-dani Empresa", configDir: "/home/dibanez/.claude-edani", default: false },
    { id: "correo", label: "E-dani Correo", configDir: "/home/dibanez/.claude-correo", default: true },
  ];

  it("is the account whose configDir the provider of Paseo uses", async () => {
    accountsDir(accounts);
    assert.equal(await accountOf("/home/dibanez/.claude-edani"), "edani");
    assert.equal(await accountOf("/home/dibanez/.claude-correo"), "correo");
  });

  it("a provider with a directory nobody owns is not an account, and nothing is read", async () => {
    accountsDir(accounts);
    await assert.rejects(accountOf("/home/dibanez/.claude-nadie"), { message: /account is not one of the accounts/ });
  });

  it("the provider without a directory of its own takes the account the service has effective", async () => {
    accountsDir(accounts);
    writeFileSync(join(process.env.CLAUDE_CUENTAS_DIR!, "service.json"), JSON.stringify({ v: 1, url: "http://127.0.0.1:1", token: "x".repeat(20) }));
    // No service answering on that port: that is not the same as an account with no id, and the plugin says so.
    await assert.rejects(accountOf(null), { message: /could not be read on this machine/ });
  });

  it("a service that answers with no account effective and none preferred is not an account", async () => {
    const dir = accountsDir(accounts);
    const state = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          v: 1,
          generated: "2026-10-12T20:00:00+02:00",
          revision: 1,
          service: { version: "2.1.0" },
          config: { preferred: null, order: [], autoJump: false, visible: [] },
          effective: null,
          accounts: [],
          events: [],
        }),
      );
    });
    await once(state.listen(0, "127.0.0.1"), "listening");
    writeFileSync(join(dir, "service.json"), JSON.stringify({ v: 1, url: `http://127.0.0.1:${(state.address() as AddressInfo).port}`, token: "x".repeat(20) }));
    try {
      await assert.rejects(accountOf(null), { message: /not one of the accounts/ });
    } finally {
      state.closeAllConnections();
      state.close();
    }
  });
});

describe("a failure while locating the session", () => {
  it("is one fixed sentence, never the Node error with its path", async () => {
    const { sideQuestion } = await import("../server/ask.ts");
    const context = { paseo: { agents: { list: async () => { throw new Error("EACCES /home/dibanez/.claude-edani/projects/x.jsonl"); } } } } as never;
    await assert.rejects(sideQuestion({ agentId: "a1", question: "¿y?" }, context), {
      message: "the session or its account could not be read on this machine",
    });
  });
});

describe("what a side question sends", () => {
  const body = (question = "¿qué hace el pill?") =>
    JSON.parse(askBody([JSON.stringify({ type: "user", message: { role: "user", content: "arregla el pill" } })], "claude-opus-5-5", question));

  it("asks with no tools at all, and streams", () => {
    assert.deepEqual(body().tools, []);
    assert.equal(body().max_tokens, 2_048);
    assert.equal(body().stream, true);
  });

  it("asks with the model picked in the panel, without Paseo's `[1m]` mark the API does not take", () => {
    const lines = [JSON.stringify({ type: "user", message: { role: "user", content: "hola" } })];
    assert.equal(JSON.parse(askBody(lines, "claude-haiku-5-5", "¿y?")).model, "claude-haiku-5-5");
    assert.equal(JSON.parse(askBody(lines, "claude-opus-4-8[1m]", "¿y?")).model, "claude-opus-4-8");
  });

  it("speaks as Claude Code, without which an OAuth bearer gets a 429 from Opus and Sonnet", () => {
    assert.deepEqual(body().system, [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }]);
  });

  it("takes the model of the agent, which is the name the router knows, and the transcript's only as fallback", () => {
    const lines = [
      JSON.stringify({ type: "user", message: { role: "user", content: "hola" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", model: "qwen3.8-flash", content: [{ type: "text", text: "hey" }] } }),
    ];
    // Medido en vivo: con el nombre del transcript (qwen3.8-flash) el router del sergio responde 403; con el del agente (qwen38-flash-next), 200.
    assert.equal(JSON.parse(askBody(lines, "qwen38-flash-next", "¿y?")).model, "qwen38-flash-next");
    assert.equal(JSON.parse(askBody(lines, null, "¿y?")).model, "qwen3.8-flash");
    assert.equal(body().model, "claude-opus-5-5");
  });

  it("puts the reminder before the question, in the last user turn", () => {
    const last = body().messages.at(-1);
    assert.equal(last.role, "user");
    const text = last.content.at(-1).text;
    assert.ok(text.indexOf("<system-reminder>") < text.indexOf("¿qué hace el pill?"));
  });

  it("answers a failure with one fixed sentence, never with a path, a url or a token", async () => {
    const { AskError } = await import("../server/accounts.ts");
    const texts = (["no-session", "no-transcript", "no-account", "unreadable", "router", "too-big", "refused", "lost"] as const).map((k) => new AskError(k).message);
    assert.equal(new Set(texts).size, texts.length);
    for (const text of texts) assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+|\/home\/|127\.0\.0\.1|Bearer/.test(text), text);
  });
});

describe("an answer that streams", () => {
  it("an id nobody started, or one already forgotten, is a fixed sentence", () => {
    assert.throws(() => answerSoFar({ id: "999999", from: 0 }), { message: "the answer was lost on the way; ask again" });
  });

  it("hands each piece of a 200 over as it arrives, and only the status of anything else", async () => {
    const router = createServer((req, res) => {
      if (req.url === "/no") {
        res.writeHead(429).end('{"error":"x"}');
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: a\n\n");
      setTimeout(() => res.end("data: b\n\n"), 50);
    });
    router.listen(0, "127.0.0.1");
    await once(router, "listening");
    const to = { host: "127.0.0.1", port: (router.address() as AddressInfo).port };
    try {
      const pieces: string[] = [];
      assert.equal(await stream(to, "/", {}, "{}", 5_000, 1_024, (text) => pieces.push(text)), 200);
      assert.deepEqual(pieces, ["data: a\n\n", "data: b\n\n"]);
      const refused: string[] = [];
      assert.equal(await stream(to, "/no", {}, "{}", 5_000, 1_024, (text) => refused.push(text)), 429);
      assert.deepEqual(refused, []);
    } finally {
      router.close();
    }
  });

  it("gives up after a silence, not after a total time", async () => {
    const router = createServer((_req, res) => {
      res.writeHead(200);
      res.write("x"); // then nothing
    });
    router.listen(0, "127.0.0.1");
    await once(router, "listening");
    try {
      await assert.rejects(stream({ host: "127.0.0.1", port: (router.address() as AddressInfo).port }, "/", {}, "{}", 200, 1_024, () => {}));
    } finally {
      router.closeAllConnections();
      router.close();
    }
  });
});
