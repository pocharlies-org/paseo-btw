import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mdBlocks, mdInline } from "../shared/markdown.ts";

describe("the answer of a side question as markdown", () => {
  it("splits bold and code spans, leaving the rest plain", () => {
    assert.deepEqual(mdInline("**Cada 5 minutos.** Lo hace `paseo-autoimport.timer`."), [
      { text: "Cada 5 minutos.", bold: true },
      { text: " Lo hace ", },
      { text: "paseo-autoimport.timer", code: true },
      { text: ".", },
    ]);
  });

  it("turns headings, bullets and numbered items into blocks without their literals", () => {
    assert.deepEqual(
      mdBlocks("# Titulo\n- **Primera pasada:** 2 min\n2. Despues\n\nY nada mas."),
      [
        { kind: "heading", text: [{ text: "Titulo" }] },
        { kind: "item", marker: "•", text: [{ text: "Primera pasada:", bold: true }, { text: " 2 min" }] },
        { kind: "item", marker: "2.", text: [{ text: "Despues" }] },
        { kind: "para", text: [{ text: "Y nada mas." }] },
      ],
    );
  });

  it("collects fenced code, and an open fence while streaming still reads as code", () => {
    assert.deepEqual(mdBlocks("antes\n```bash\nls -a\n```\ndespues"), [
      { kind: "para", text: [{ text: "antes" }] },
      { kind: "code", text: "ls -a" },
      { kind: "para", text: [{ text: "despues" }] },
    ]);
    assert.deepEqual(mdBlocks("```\nkubectl get po"), [{ kind: "code", text: "kubectl get po" }]);
  });

  it("keeps an unterminated bold literal while the text streams", () => {
    assert.deepEqual(mdInline("**Cada"), [{ text: "**Cada" }]);
  });
});
