import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inFlight, setThread, subscribe, threadOf } from "../client/threads.ts";

describe("the /btw threads", () => {
  it("an answer that arrives after the panel was reopened or re-pointed reaches whoever reads that session, and no other session changes", () => {
    let notified = 0;
    const stop = subscribe(() => notified++);
    const other = threadOf("b");
    setThread("a", [{ id: 1, question: "¿y?", startedAt: 0 }]);
    assert.equal(inFlight(threadOf("a")[0]), true);
    setThread("a", threadOf("a").map((turn) => ({ ...turn, answer: "s" })));
    assert.equal(inFlight(threadOf("a")[0]), true, "a streaming answer is still in flight");
    setThread("a", threadOf("a").map((turn) => ({ ...turn, answer: "sí", done: true })));
    assert.equal(inFlight(threadOf("a")[0]), false);
    assert.equal(threadOf("b"), other, "the same array: the panel of another session does not re-render");
    assert.equal(notified, 3);
    stop();
    setThread("a", []);
    assert.equal(notified, 3, "a closed panel is no longer told");
  });

  it("only the end ends the wait", () => {
    assert.equal(inFlight({ id: 2, question: "¿y?", startedAt: 0, error: "the local router did not answer", done: true }), false);
    assert.equal(inFlight({ id: 3, question: "¿y?", startedAt: 0 }), true);
  });
});
