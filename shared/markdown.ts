// The answer of a side question arrives as markdown and the panel is plain React Native `Text`: the plugin SDK ships no markdown
// component and the plugin tarball carries no node_modules, so the parser lives here, pure and tested here. It covers what the
// models actually write in an answer: bold, inline code, bullet and numbered lists, headings, fenced blocks.

export type Inline = { text: string; bold?: boolean; code?: boolean };
export type Block =
  | { kind: "code"; text: string }
  | { kind: "heading"; text: Inline[] }
  | { kind: "item"; marker: string; text: Inline[] }
  | { kind: "para"; text: Inline[] };

// A span is `**bold**` or `code` between backticks, never crossing a line. shortcut: nested emphasis (`**a *b* c**`) is not
// unwrapped and stays literal; upgrade only if answers start using it.
const SPAN = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/;

export function mdInline(text: string): Inline[] {
  return text
    .split(SPAN)
    .filter((part) => part !== "")
    .map((part) =>
      SPAN.test(part) && part.startsWith("**")
        ? { text: part.slice(2, -2), bold: true }
        : SPAN.test(part) && part.startsWith("`")
          ? { text: part.slice(1, -1), code: true }
          : { text: part },
    );
}

export function mdBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  let fenced: string[] | null = null;
  for (const line of source.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      if (fenced) blocks.push({ kind: "code", text: fenced.join("\n") });
      fenced = fenced ? null : [];
      continue;
    }
    if (fenced) fenced.push(line);
    else if (/^\s*$/.test(line)) continue;
    else if (/^ {0,3}#{1,6}\s/.test(line)) blocks.push({ kind: "heading", text: mdInline(line.replace(/^ {0,3}#{1,6}\s+/, "")) });
    else if (/^\s*[-*+]\s/.test(line)) blocks.push({ kind: "item", marker: "•", text: mdInline(line.replace(/^\s*[-*+]\s+/, "")) });
    else if (/^\s*\d+[.)]\s/.test(line)) blocks.push({ kind: "item", marker: line.match(/^\s*(\d+)[.)]/)![1] + ".", text: mdInline(line.replace(/^\s*\d+[.)]\s+/, "")) });
    else blocks.push({ kind: "para", text: mdInline(line) });
  }
  // While the answer streams the closing fence may not have arrived yet: an open block still renders as code.
  if (fenced) blocks.push({ kind: "code", text: fenced.join("\n") });
  return blocks;
}
