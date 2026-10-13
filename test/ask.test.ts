import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_CONTEXT_CHARS, applyEvent, readEvents, sideQuestionText, transcriptMessages, withQuestion, type Answer } from "../shared/ask.ts";

const line = (o: object) => JSON.stringify(o);
const user = (content: unknown) => line({ type: "user", message: { role: "user", content } });
const as = (content: unknown, model = "claude-opus-5-5") => line({ type: "assistant", message: { role: "assistant", model, content } });

describe("the context of a side question", () => {
  it("flattens tools to text and keeps who said what", () => {
    const { messages, model } = transcriptMessages([
      user("Arregla el pill"),
      as([{ type: "thinking", thinking: "mm" }, { type: "tool_use", name: "Read", input: {} }]),
      user([{ type: "tool_result", content: "el codigo" }]),
      as([{ type: "text", text: "listo" }]),
      line({ type: "summary", summary: "no es un mensaje" }),
    ]);
    assert.equal(model, "claude-opus-5-5");
    assert.deepEqual(messages, [
      { role: "user", content: [{ type: "text", text: "Arregla el pill" }] },
      { role: "assistant", content: [{ type: "text", text: "[called Read]" }] },
      { role: "user", content: [{ type: "text", text: "[tool result] el codigo" }] },
      { role: "assistant", content: [{ type: "text", text: "listo" }] },
    ]);
  });

  it("merges what came one after the other from the same side", () => {
    const { messages } = transcriptMessages([user("una"), user("dos"), as([{ type: "text", text: "a" }]), as([{ type: "text", text: "b" }])]);
    assert.deepEqual(messages.map((m) => m.content.map((b) => b.text)), [["una", "dos"], ["a", "b"]]);
  });

  it("skips a cut line and an empty message", () => {
    const { messages, model } = transcriptMessages(['{"type":"user"', user([{ type: "text", text: "  " }]), as([])]);
    assert.deepEqual(messages, []);
    assert.equal(model, null);
  });

  it("keeps the newest messages when the transcript is too big, and says so", () => {
    const big = "x".repeat(20_000);
    const lines = Array.from({ length: 200 }, (_, i) => (i % 2 ? as([{ type: "text", text: `${i} ${big}` }]) : user(`${i} ${big}`)));
    const { messages } = transcriptMessages(lines);
    assert.ok(messages.length < 200);
    assert.match(messages[0].content[0].text, /earlier messages left out/);
    assert.match(messages[messages.length - 1].content[0].text, new RegExp(`^199 `));
    assert.ok(messages.reduce((n, m) => n + m.content.reduce((k, b) => k + b.text.length, 0), 0) <= MAX_CONTEXT_CHARS + 10_000);
  });
});

describe("the question and the answer", () => {
  it("puts Claude Code's reminder in front of the question", () => {
    const text = sideQuestionText("¿Qué queda del pill?");
    assert.ok(text.startsWith("<system-reminder>This is a side question from the user"));
    assert.ok(text.includes("You have NO tools available"));
    assert.ok(text.endsWith("¿Qué queda del pill?"));
  });

  it("starts the context at the last compact boundary, where the live session starts", () => {
    const { messages } = transcriptMessages([
      user("lo que la sesion ya compacto"),
      line({ type: "system", subtype: "compact_boundary", content: "Conversation compacted" }),
      user("el resumen de la compactacion"),
      as([{ type: "text", text: "sigamos" }]),
    ]);
    assert.deepEqual(messages.map((m) => m.content[0].text), ["el resumen de la compactacion", "sigamos"]);
  });

  it("adds the question to the last user turn, never as a second assistant turn", () => {
    const afterUser = withQuestion([{ role: "user", content: [{ type: "text", text: "hola" }] }], "¿cuánto queda?");
    assert.equal(afterUser.length, 1);
    assert.equal(afterUser[0].role, "user");
    assert.equal(afterUser[0].content.length, 2);
    const afterAssistant = withQuestion([{ role: "assistant", content: [{ type: "text", text: "hola" }] }], "¿cuánto queda?");
    assert.deepEqual(afterAssistant.map((m) => m.role), ["assistant", "user"]);
  });

  const sse = (...events: unknown[]) => events.map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join("");
  const streamed = (text: string, chunk = 7) => {
    const answer: Answer = { text: "", model: "" };
    let pending = "";
    for (let i = 0; i < text.length; i += chunk) {
      const { events, rest } = readEvents(pending + text.slice(i, i + chunk)); // any cut, also inside an event
      pending = rest;
      for (const event of events) applyEvent(answer, event);
    }
    return answer;
  };

  it("builds the text from the deltas as they arrive, whatever the chunks cut, and says which model the router names", () => {
    const text = sse(
      { type: "message_start", message: { model: "qwen3.8-flash" } },
      { type: "content_block_start", content_block: { type: "text" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "38 " } },
      { type: "ping" },
      { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "minutos ñ" } },
      { type: "message_stop" },
    );
    assert.deepEqual(streamed(text), { text: "38 minutos ñ", model: "qwen3.8-flash" });
    assert.deepEqual(streamed(text, 1), { text: "38 minutos ñ", model: "qwen3.8-flash" });
  });

  it("keeps an incomplete event for the next chunk", () => {
    const { events, rest } = readEvents('data: {"type":"ping"}\n\ndata: {"type":"mess');
    assert.deepEqual(events, [{ type: "ping" }]);
    assert.equal(rest, 'data: {"type":"mess');
  });

  it("marks an answer that tried to call a tool, and one the stream ended with an error", () => {
    const tool = streamed(sse({ type: "content_block_start", content_block: { type: "tool_use", name: "Bash" } }));
    assert.equal(tool.tool, "Bash");
    assert.equal(streamed(sse({ type: "error", error: { type: "overloaded_error" } })).failed, true);
  });
});
