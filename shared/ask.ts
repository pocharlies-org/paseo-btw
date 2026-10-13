// The side question of `/btw`: one answer from the session's own context, with no tools and without touching the session.
// Copied from Claude Code 2.1.296 (read out of its binary): a separate lightweight call, the transcript as context, no tools,
// one response, and a reminder that forbids tool calls and promises. `skipTranscript` and `skipCacheWrite` of Claude Code are our
// not writing to the transcript and calling the router directly: nothing of this reaches the session.

/** The wrapper Claude Code puts around the question. Kept word for word: it is what keeps the answer an answer. */
export const SIDE_QUESTION_REMINDER = `<system-reminder>This is a side question from the user. You must answer this question directly in a single response.

IMPORTANT CONTEXT:
- You are a separate, lightweight agent spawned to answer this one question
- The main agent is NOT interrupted - it continues working independently in the background
- You share the conversation context but are a completely separate instance
- Do NOT reference being interrupted or what you were "previously doing" - that framing is incorrect

CRITICAL CONSTRAINTS:
- You have NO tools available - you cannot read files, run commands, search, or take any actions
- Do NOT write tool calls or tool output as text (for example invoke or function_calls XML blocks) - nothing you write here is executed; if answering would need reading files, running commands, or searching, say that can't be checked from a side question and suggest asking in the main conversation
- This is a one-off response - there will be no follow-up turns
- You can ONLY provide information based on what you already know from the conversation context
- NEVER say things like "Let me try...", "I'll now...", "Let me check...", or promise to take any action
- If you don't know the answer, say so - do not offer to look it up or investigate

Simply answer the question with the information you have.</system-reminder>`;

/** The question with Claude Code's reminder in front of it, as one user message. */
export const sideQuestionText = (question: string) => `${SIDE_QUESTION_REMINDER}\n\n${question.trim()}`;

export type Block = { type: "text"; text: string };
export type Message = { role: "user" | "assistant"; content: Block[] };

/** What the transcript still says once the tools are taken away: a tool call is one line about it, its result is its text. */
function blocks(content: unknown): Block[] {
  if (typeof content === "string") return content.trim() ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: Block[] = [];
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) out.push({ type: "text", text: part.text });
    else if (part?.type === "tool_use" && typeof part.name === "string") out.push({ type: "text", text: `[called ${part.name}]` });
    else if (part?.type === "tool_result") {
      const text =
        typeof part.content === "string"
          ? part.content
          : Array.isArray(part.content)
            ? part.content.map((c: any) => (c?.type === "text" ? c.text : "")).join("")
            : "";
      if (text.trim()) out.push({ type: "text", text: `[tool result] ${text.slice(0, 2_000)}` });
    }
    // thinking and redacted_thinking are dropped: they are signed for the model that wrote them and this call has no tools.
  }
  return out;
}

/** The context of a side question: the transcript's messages with the tools flattened, and the model the session was using. */
export function transcriptMessages(lines: string[]): { messages: Message[]; model: string | null } {
  // A compacted transcript still holds everything the session compacted away; the live context starts at its last compact boundary.
  const start = lines.findLastIndex((l) => l.includes('"compact_boundary"')) + 1;
  const messages: Message[] = [];
  let model: string | null = null;
  for (const line of lines.slice(start)) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a line cut by a write in progress
    }
    const role = entry?.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const content = blocks(entry.message.content);
    if (!content.length) continue;
    if (role === "assistant" && typeof entry.message.model === "string") model = entry.message.model;
    const last = messages[messages.length - 1];
    if (last?.role === role) last.content.push(...content);
    else messages.push({ role, content });
  }
  return { messages: cap(messages), model };
}

/**
 * The most it may cost to answer a side question: ~100k tokens, so it fits a 200k window with room for the answer. The newest messages are
 * kept and the answer is told what was left out. shortcut: one number for every model; upgrade if a smaller window needs its own.
 */
export const MAX_CONTEXT_CHARS = 400_000;

function cap(messages: Message[]): Message[] {
  const size = (ms: Message[]) => ms.reduce((n, m) => n + m.content.reduce((k, b) => k + b.text.length, 0), 0);
  let dropped = 0;
  while (messages.length > 1 && size(messages) > MAX_CONTEXT_CHARS) {
    const [oldest, ...rest] = messages as [Message, ...Message[]];
    messages = rest;
    dropped += oldest.content.length;
  }
  if (dropped) messages.unshift({ role: "user", content: [{ type: "text", text: `[${dropped} earlier messages left out of this side question]` }] });
  return messages;
}

/** An answer as far as it has come: the text so far, the model the router says answers, a tool call that stops it, an error event. */
export type Answer = { text: string; model: string; tool?: string; failed?: boolean };

/** Splits the complete server-sent events off the front of `buffer`: the JSON `data` of each, and the incomplete tail to keep for later. */
export function readEvents(buffer: string): { events: unknown[]; rest: string } {
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? "";
  const events = parts.flatMap((part) => {
    const data = part
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    try {
      return data ? [JSON.parse(data)] : [];
    } catch {
      return [];
    }
  });
  return { events, rest };
}

/**
 * One event of the Messages stream applied to the answer. The model is the one the router names (the panel shows it, because the same
 * question can go to the resident or to a fallback); a `tool_use` block means the model tried to call a tool instead of answering.
 */
export function applyEvent(answer: Answer, event: any) {
  if (event?.type === "message_start" && typeof event.message?.model === "string") answer.model = event.message.model;
  else if (event?.type === "content_block_start" && event.content_block?.type === "tool_use") answer.tool ??= String(event.content_block.name ?? "?");
  else if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && typeof event.delta.text === "string") answer.text += event.delta.text;
  else if (event?.type === "error") answer.failed = true;
}

/** The question goes last: after the last message of the session if that one is from the user, else as its own turn. */
export function withQuestion(messages: Message[], question: string): Message[] {
  const text = sideQuestionText(question);
  const last = messages[messages.length - 1];
  if (last?.role === "user") return [...messages.slice(0, -1), { role: "user", content: [...last.content, { type: "text", text }] }];
  return [...messages, { role: "user", content: [{ type: "text", text }] }];
}
