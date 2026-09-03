import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, onLive } from "./api";
import type { Preferences, Plan } from "@core/types";

export interface Context {
  now: string;
  mode: "claude" | "local";
  prefs: Preferences & { hasApiKey?: boolean };
  counts: { openTasks: number; overdue: number; todayEvents: number; memories: number; people: number; unreadNudges: number };
  plan: Plan | null;
}

// ---------- tiny external store ----------
type State = { ctx?: Context; toast?: string; view: string; focus?: { title: string; minutes: number; startedAt: number; id?: string; taskId?: string } };
let state: State = { view: location.hash.replace(/^#\/?/, "") || "now" };
const subs = new Set<() => void>();
export function setState(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  for (const s of subs) s();
}
export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => sel(state),
    () => sel(state),
  );
}
export function toast(msg: string, ms = 2600): void {
  setState({ toast: msg });
  setTimeout(() => setState((s) => (s.toast === msg ? { toast: undefined } : {})), ms);
}
export function navigate(view: string): void {
  location.hash = `/${view}`;
  setState({ view });
}
window.addEventListener("hashchange", () => setState({ view: location.hash.replace(/^#\/?/, "") || "now" }));

export async function refreshContext(): Promise<void> {
  try {
    const ctx = await api.get<Context>("/context");
    setState({ ctx });
  } catch {
    /* offline */
  }
}

// ---------- resource hook: fetch + auto-refresh on live events ----------
export function useResource<T>(path: string | null, entities: string[], deps: unknown[] = []): { data: T | undefined; loading: boolean; error?: string; reload: () => void } {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(!!path);
  const [error, setError] = useState<string>();
  const alive = useRef(true);
  const depsKey = JSON.stringify(deps);
  const load = useCallback(() => {
    if (!path) return;
    api
      .get<T>(path)
      .then((d) => {
        if (!alive.current) return;
        setData(d);
        setError(undefined);
      })
      .catch((e: Error) => alive.current && setError(e.message))
      .finally(() => alive.current && setLoading(false));
  }, [path, depsKey]);
  useEffect(() => {
    alive.current = true;
    load();
    const off = onLive((e) => {
      if (e.type === "mutation" && entities.includes(String(e.entity))) load();
      if (e.type === "nudge" && entities.includes("nudge")) load();
      if (e.type === "ritual" && (entities.includes("nudge") || entities.includes("plan"))) load();
    });
    return () => {
      alive.current = false;
      off();
    };
  }, [load, entities.join(",")]);
  return { data, loading, error, reload: load };
}

/** A ticking "now" so relative times and progress bars stay honest. */
export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

// ---------- command channel: anything in the UI can talk to the agent ----------
let commandHandler: ((text: string) => void) | undefined;
export function registerCommandHandler(fn: (text: string) => void): () => void {
  commandHandler = fn;
  return () => {
    if (commandHandler === fn) commandHandler = undefined;
  };
}
export function runCommand(text: string): void {
  if (commandHandler) commandHandler(text);
  else toast("Agent not ready yet");
}
