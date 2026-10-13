import type { PluginAgentPanelProps, PluginClientContext } from "@getpaseo/plugin/client";
import { useAgent, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ScrollView, Text, TextInput, Pressable, View } from "react-native";
import { sideAnswerSoFar, sideQuestion } from "../shared/contract.ts";
import { Markdown } from "./markdown.tsx";
import { inFlight, setThread, subscribe, threadOf, type Turn } from "./threads.ts";

// `/btw`, the same system as Claude Code's: the question is answered by one call with no tools over the session's own transcript, so the
// agent is not interrupted, nothing is forked and the session keeps its context untouched. The command only hands the question to the
// panel, and the panel runs the call: the answer arrives while the agent is still working.
// Like Claude Code's panel it is a conversation: every question and its answer stack below the previous one, the input stays at the bottom,
// and one button clears the thread. The panel listens, so a second `/btw` asks again even with the panel already open; the hand-off is
// consumed on mount because the command hands the question over before the panel exists.
// The question is bound to the session whose composer was used (measured in the 0.11.2 bundle: `openPanel` from an agent command calls
// `openAgentPanel` with that agent, and the pane's resource is `<plugin>:<panel>:agent:<agentId>`). The sidebar is one per workspace, so
// the same pane can be showing another session's panel: the panel names its session and shows only that session's thread.
// The answer streams: the question returns an id at once (Paseo cuts every plugin RPC at 30 s) and the panel asks for what has arrived every
// POLL_MS, so the text grows like in the main window. The model is the session's unless another one of its provider is picked here.

const POLL_MS = 400;
const held = new Map<string, string>();
const listeners = new Map<string, Set<(question: string) => void>>();
// The model picked for a session's side questions; none = the session's own. Outside the component, like the threads, so a `/btw` from the
// composer asks with the model on screen even after the pane was re-pointed.
const picked = new Map<string, string>();
let lastTurn = 0;

export function contributeBtw(client: PluginClientContext) {
  client.addSlashCommand({
    name: "btw",
    description: "Ask a side question: no tools, the context of this session, the agent keeps working",
    argumentHint: "<question>",
    context: "agent",
    onSubmit: ({ agent, args, openPanel }) => {
      const question = args.trim();
      const watching = listeners.get(agent.id);
      if (watching?.size) for (const notify of watching) notify(question);
      // Nobody listening yet: the panel opens on this gesture and takes the question when it mounts.
      else held.set(agent.id, question);
      // The sidebar on the right on a wide screen. A phone has no sidebar to open: there the panel goes to its own tab.
      try {
        openPanel("btw", { location: "explorer" });
      } catch {
        openPanel("btw");
      }
    },
  });
  client.addWorkspacePanel({
    id: "btw",
    context: "agent",
    title: "Side question",
    icon: "MessageCircleQuestion",
    locations: ["workspace", "explorer"],
    Component: BtwPanel,
  });
}

function BtwPanel({ agentId, theme, layout, navigation }: PluginAgentPanelProps) {
  const start = useRpc(sideQuestion);
  const soFar = useRpc(sideAnswerSoFar);
  const paseo = usePaseo();
  const turns = useSyncExternalStore(subscribe, () => threadOf(agentId));
  const [now, setNow] = useState(Date.now);
  const waiting = turns.some(inFlight);
  const [question, setQuestion] = useState("");
  const title = useAgent(agentId, (agent) => agent?.title ?? agentId.slice(0, 8));
  const provider = useAgent(agentId, (agent) => agent?.provider);
  const sessionModel = useAgent(agentId, (agent) => agent?.model);
  const [models, setModels] = useState<{ id: string; label: string }[]>([]);
  const [picking, setPicking] = useState(false);
  const [, repaint] = useState(0);
  const chosen = picked.get(agentId) ?? null;
  const labelOf = (id: string | null | undefined) => models.find((model) => model.id === id)?.label ?? id ?? "?";
  const choose = (id: string | null) => {
    if (id) picked.set(agentId, id);
    else picked.delete(agentId);
    setPicking(false);
    repaint((n) => n + 1);
  };
  const scroller = useRef<ScrollView>(null);
  const patch = (id: number, changes: Partial<Turn>) => setThread(agentId, threadOf(agentId).map((turn) => (turn.id === id ? { ...turn, ...changes } : turn)));
  const askNow = (text: string) => {
    const id = ++lastTurn;
    setNow(Date.now());
    setThread(agentId, [...threadOf(agentId), { id, question: text, startedAt: Date.now() }]);
    const model = picked.get(agentId);
    start({ agentId, question: text, ...(model ? { model } : {}) })
      .then(async ({ id: job }) => {
        let answer = "";
        for (;;) {
          const part = await soFar({ id: job, from: answer.length });
          answer += part.text;
          if (part.done) {
            const end = part.tool
              ? { answer: `The model tried to call ${part.tool} instead of answering directly. Nothing was executed. Ask in the conversation to have it checked.` }
              : { answer: answer.trim() || (part.error ? undefined : "(no answer)"), error: part.error };
            return patch(id, { ...end, model: part.model, done: true });
          }
          if (part.text) patch(id, { answer, model: part.model });
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
      })
      .catch((error) => patch(id, { error: String((error as Error).message), done: true }));
  };
  useEffect(() => {
    const receive = (text: string) => {
      setQuestion("");
      if (text) askNow(text);
    };
    const first = held.get(agentId);
    if (first !== undefined) {
      held.delete(agentId);
      receive(first);
    }
    const watching = listeners.get(agentId) ?? new Set();
    listeners.set(agentId, watching);
    watching.add(receive);
    return () => {
      watching.delete(receive);
    };
  }, [agentId]);
  useEffect(() => {
    setPicking(false);
    if (!provider) return;
    let live = true;
    // The same list as the composer's model picker for this provider: the Claude models and the local ones the router knows.
    paseo.providers.listModels(provider).then(
      ({ models }) => live && setModels((models ?? []).map(({ id, label }) => ({ id, label }))),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [provider, agentId]);
  useEffect(() => {
    scroller.current?.scrollToEnd({ animated: true });
  }, [turns]);
  // While a question is open the seconds tick, so a call in flight is told from a hung one; the server gives up after 120 s of silence.
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [waiting]);
  const styles = useMemo(
    () => ({
      panel: { padding: layout.compact ? 10 : 16, gap: 8, flex: 1, backgroundColor: theme.colors.surface0 },
      row: { flexDirection: "row" as const, gap: 8, alignItems: "center" as const },
      turn: { gap: 4, paddingBottom: 10 },
      input: { flex: 1, padding: 8, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, color: theme.colors.foreground, backgroundColor: theme.colors.surface1 },
      button: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6, backgroundColor: theme.colors.surface2 },
      picker: { alignSelf: "flex-end" as const, paddingVertical: 4, paddingHorizontal: 8, borderRadius: 6, backgroundColor: theme.colors.surface1 },
      option: { paddingVertical: 6, paddingHorizontal: 8 },
      text: { color: theme.colors.foreground },
      bold: { fontWeight: "700" as const },
      heading: { fontWeight: "700" as const, fontSize: 14 },
      codeInline: { fontFamily: "monospace", backgroundColor: theme.colors.surface2 },
      code: { fontFamily: "monospace", backgroundColor: theme.colors.surface1, padding: 8, borderRadius: 6 },
      muted: { color: theme.colors.foregroundMuted },
      danger: { color: theme.colors.statusDanger },
    }),
    [theme, layout.compact],
  );
  const send = () => {
    const text = question.trim();
    if (!text) return;
    setQuestion("");
    askNow(text);
  };
  return (
    <View style={styles.panel}>
      {/* The sidebar is one per workspace, so without this nobody knows which session the panel belongs to. */}
      <Pressable
        disabled={navigation?.openAgent === undefined}
        onPress={() => navigation?.openAgent?.({ agentId })}
        accessibilityRole="button"
        accessibilityLabel={`Open session ${title}`}
      >
        <Text style={styles.muted} numberOfLines={1}>
          Session: {title}
        </Text>
      </Pressable>
      <ScrollView ref={scroller} style={{ flex: 1 }} contentContainerStyle={{ gap: 8 }} keyboardShouldPersistTaps="handled">
        {turns.map((turn) => (
          <View key={turn.id} style={styles.turn}>
            <Text style={styles.muted}>You: {turn.question}</Text>
            {turn.answer !== undefined && <Markdown text={turn.answer} styles={styles} />}
            {inFlight(turn) && (
              <Text style={styles.muted}>
                {turn.answer ? "…" : "Answering without tools…"} {Math.max(0, Math.round((now - turn.startedAt) / 1000))} s
              </Text>
            )}
            {turn.error !== undefined && <Text style={styles.danger}>{turn.error}</Text>}
            {turn.done && turn.model !== undefined && turn.model !== "" && <Text style={styles.muted}>Answered by {turn.model}</Text>}
          </View>
        ))}
      </ScrollView>
      {picking && (
        <ScrollView style={{ maxHeight: 220 }} keyboardShouldPersistTaps="handled">
          {[null, ...models.map((model) => model.id)].map((id) => (
            <Pressable key={id ?? ""} onPress={() => choose(id)} accessibilityRole="button" style={styles.option}>
              <Text style={id === chosen ? styles.text : styles.muted}>{id ? labelOf(id) : `Session model (${labelOf(sessionModel)})`}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      <Pressable
        onPress={() => setPicking((open) => !open)}
        accessibilityRole="button"
        accessibilityLabel="Model for side questions"
        style={styles.picker}
      >
        <Text style={styles.muted} numberOfLines={1}>
          {chosen ? labelOf(chosen) : `${labelOf(sessionModel)} · session`} ▾
        </Text>
      </Pressable>
      <View style={styles.row}>
        <TextInput
          value={question}
          onChangeText={setQuestion}
          onSubmitEditing={send}
          placeholder="Ask about this session"
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="sentences"
          accessibilityLabel="Side question"
          style={styles.input}
        />
        <Pressable style={styles.button} onPress={send} accessibilityRole="button" accessibilityLabel="Ask">
          <Text style={styles.text}>Ask</Text>
        </Pressable>
        <Pressable
          style={styles.button}
          onPress={() => setThread(agentId, [])}
          accessibilityRole="button"
          accessibilityLabel="Clear this conversation"
          disabled={turns.length === 0}
        >
          <Text style={turns.length === 0 ? styles.muted : styles.text}>Clear</Text>
        </Pressable>
      </View>
    </View>
  );
}
