import type { AgentEvent, Card, Turn } from "@core/types";

const BASE = "/api";

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export const api = {
  get: <T>(p: string) => req<T>("GET", p),
  post: <T>(p: string, b?: unknown) => req<T>("POST", p, b ?? {}),
  put: <T>(p: string, b?: unknown) => req<T>("PUT", p, b ?? {}),
  patch: <T>(p: string, b?: unknown) => req<T>("PATCH", p, b ?? {}),
  del: <T>(p: string) => req<T>("DELETE", p),
};

/** Stream an agent turn over SSE (POST). */
export async function streamAgent(message: string, conversationId: string, onEvent: (e: AgentEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`${BASE}/agent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, conversationId }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`agent: ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = chunk
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("\n");
      if (!data) continue;
      try {
        onEvent(JSON.parse(data) as AgentEvent);
      } catch {
        /* skip malformed */
      }
    }
  }
}

export type LiveEvent = { type: string; [k: string]: unknown };
type Listener = (e: LiveEvent) => void;
const listeners = new Set<Listener>();
let es: EventSource | undefined;

/** Server → client live channel. Reconnects automatically (EventSource does that for us). */
export function connectLive(): void {
  if (es) return;
  es = new EventSource(`${BASE}/stream`);
  es.addEventListener("error", () => { for (const l of listeners) l({ type: "offline" }); });
  es.addEventListener("open", () => { for (const l of listeners) l({ type: "online" }); });
  for (const t of ["hello", "nudge", "mutation", "ritual", "focus"]) {
    es.addEventListener(t, (ev) => {
      let data: LiveEvent = { type: t };
      try {
        data = { ...(JSON.parse((ev as MessageEvent).data) as object), type: t };
      } catch {
        /* ignore */
      }
      for (const l of listeners) l(data);
    });
  }
}
export function onLive(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
/** Local fan-out so a mutation from this tab refreshes other views immediately. */
export function emitLocal(e: LiveEvent): void {
  for (const l of listeners) l(e);
}

export type { AgentEvent, Card, Turn };
