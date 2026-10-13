// The /btw threads, one per session and outside any component: the pane is re-pointed to another session without remounting, and it can be
// closed and reopened while a question is in flight. So a panel reads its session's thread from here and re-renders when a thread changes:
// an answer that arrives late lands in the panel showing that session, and in no other.
export type Turn = { id: number; question: string; startedAt: number; answer?: string; error?: string; model?: string; done?: boolean };

const threads = new Map<string, Turn[]>();
const listeners = new Set<() => void>();
const NONE: Turn[] = [];

/** The same array until that session's thread changes, as `useSyncExternalStore` needs. */
export const threadOf = (agentId: string): Turn[] => threads.get(agentId) ?? NONE;

export function setThread(agentId: string, next: Turn[]) {
  threads.set(agentId, next);
  for (const notify of listeners) notify();
}

export function subscribe(notify: () => void) {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}

/** Not ended yet: the answer is still arriving, or has not started. */
export const inFlight = (turn: Turn) => !turn.done;
