import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { route } from "../server/route.ts";
import { answerSoFar, askBody } from "../server/ask.ts";
import { stream } from "../server/http.ts";

// The two decisions `server/ask.ts` takes before any network is involved: where to send, and what. The transport is `server/http.ts`.
const made: string[] = [];

/** A throwaway PASEO_HOME whose config.json has `env` as the `claude` provider's env. */
function paseoHome(env: unknown): void {
  const dir = mkdtempSync(join(tmpdir(), "ask-paseo-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ agents: { providers: { claude: { env } } } }));
  process.env.PASEO_HOME = dir;
  made.push(dir);
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.PASEO_HOME;
});

describe("where a side question goes", () => {
  it("is the LiteLLM of Paseo's claude provider, with its key", async () => {
    paseoHome({ ANTHROPIC_BASE_URL: "https://litellm.example.com", ANTHROPIC_AUTH_TOKEN: "sk-x" });
    const { url, key } = await route();
    assert.equal(url.href, "https://litellm.example.com/");
    assert.equal(key, "sk-x");
  });

  it("the key goes over https or to loopback only", async () => {
    for (const base of ["http://litellm.example.com", "https://user@evil.example", "https://litellm.example.com/x", "ftp://127.0.0.1"]) {
      paseoHome({ ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: "sk-x" });
      await assert.rejects(route(), { message: /no LiteLLM route/ }, base);
    }
    paseoHome({ ANTHROPIC_BASE_URL: "http://127.0.0.1:4000", ANTHROPIC_AUTH_TOKEN: "sk-x" });
    assert.equal((await route()).url.port, "4000");
  });

  it("no provider, no URL or no key is no route, never a Node error", async () => {
    for (const env of [undefined, { ANTHROPIC_BASE_URL: "https://litellm.example.com" }, { ANTHROPIC_AUTH_TOKEN: "sk-x" }]) {
      paseoHome(env);
      await assert.rejects(route(), { message: /no LiteLLM route/ });
    }
    process.env.PASEO_HOME = join(tmpdir(), "no-such-paseo-home");
    await assert.rejects(route(), { message: /no LiteLLM route/ });
  });
});

describe("a failure while locating the session", () => {
  it("is one fixed sentence, never the Node error with its path", async () => {
    const { sideQuestion } = await import("../server/ask.ts");
    const context = { paseo: { agents: { list: async () => { throw new Error("EACCES /home/dibanez/.claude-edani/projects/x.jsonl"); } } } } as never;
    await assert.rejects(sideQuestion({ agentId: "a1", question: "¿y?" }, context), {
      message: "the session could not be read on this machine",
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

  it("takes the model of the agent, which is the name LiteLLM knows, and the transcript's only as fallback", () => {
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
    const { AskError } = await import("../server/route.ts");
    const texts = (["no-session", "no-transcript", "no-route", "unreadable", "router", "too-big", "refused", "lost"] as const).map((k) => new AskError(k).message);
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
    const to = new URL(`http://127.0.0.1:${(router.address() as AddressInfo).port}`);
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
      await assert.rejects(stream(new URL(`http://127.0.0.1:${(router.address() as AddressInfo).port}`), "/", {}, "{}", 200, 1_024, () => {}));
    } finally {
      router.closeAllConnections();
      router.close();
    }
  });
});
