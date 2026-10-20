import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FAILURE_TEXT } from "../server/route.ts";
import { sideAnswerSoFar, sideQuestion } from "../shared/contract.ts";
import { install } from "./support/harness.ts";

// The static promises of the plugin: only the two RPCs exist, the schemas are strict, nothing is logged and nothing that reaches the
// screen carries a path, a URL or a bearer. The behaviour against a fake router is in ask-server.test.ts.

function sources(dir = "."): string[] {
  return readdirSync(join(dir)).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" || name === "test" ? [] : sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("the plugin registers only the side question", () => {
  it("two RPCs and nothing else; any other registration throws", () => {
    const { handlers, cleanup } = install();
    assert.deepEqual([...handlers.keys()], ["agent.side-question", "agent.side-question.poll"]);
    cleanup();
  });

  it("the question is strict: no extra keys, no empty text, only a routable model name", () => {
    assert.doesNotThrow(() => sideQuestion.input.parse({ agentId: "a", question: "¿cuándo?", model: "claude-haiku-4-5[1m]" }));
    for (const bad of [
      { agentId: "a", question: "   " },
      { agentId: "a", question: "x", extra: 1 },
      { agentId: "a", question: "x", model: "rm -rf /" },
      { agentId: "", question: "x" },
    ])
      assert.throws(() => sideQuestion.input.parse(bad), Error, JSON.stringify(bad));
  });

  it("the poll wants an id and a non-negative offset", () => {
    assert.doesNotThrow(() => sideAnswerSoFar.input.parse({ id: "1", from: 0 }));
    assert.throws(() => sideAnswerSoFar.input.parse({ id: "1", from: -1 }));
    assert.throws(() => sideAnswerSoFar.input.parse({ id: "1", from: 0, extra: 1 }));
  });

  it("an id nobody knows answers with the fixed lost text, never a stack", async () => {
    const { rpc, cleanup } = install();
    await assert.rejects(rpc("agent.side-question.poll", { id: "99", from: 0 }), /lost on the way/);
    cleanup();
  });
});

describe("P3.2 · nothing is logged and nothing leaks", () => {
  it("no source calls console, stdout or stderr", () => {
    const offences = sources().filter((file) => /console\.|process\.(stdout|stderr)/.test(readFileSync(file, "utf8")));
    assert.deepEqual(offences, []);
  });

  it("every failure text is safe for the screen: no path, no URL, no bearer", () => {
    for (const text of Object.values(FAILURE_TEXT)) {
      assert.doesNotMatch(text, /[/\\]|:\/|\btoken\b|bearer/i, text);
    }
  });
});
