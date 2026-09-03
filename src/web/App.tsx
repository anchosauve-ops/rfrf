import { useEffect } from "react";
import { connectLive, onLive } from "./lib/api";
import { navigate, refreshContext, setState, useStore } from "./lib/store";
import { Composer } from "./components/Composer";
import { FocusOverlay } from "./components/Focus";
import { Onboarding } from "./components/Onboarding";
import { I } from "./components/Icons";
import { NowView } from "./views/Now";
import { DayView } from "./views/Day";
import { TasksView } from "./views/Tasks";
import { MemoryView } from "./views/Memory";
import { PeopleView } from "./views/People";
import { RitualsView } from "./views/Rituals";
import { SettingsView } from "./views/Settings";

const NAV = [
  { key: "now", label: "Now", icon: I.now },
  { key: "day", label: "Day", icon: I.day },
  { key: "tasks", label: "Tasks", icon: I.tasks },
  { key: "memory", label: "Memory", icon: I.memory },
  { key: "people", label: "People", icon: I.people },
  { key: "rituals", label: "Rituals", icon: I.rituals },
  { key: "settings", label: "Settings", icon: I.settings },
] as const;

export function App() {
  const view = useStore((s) => s.view);
  const ctx = useStore((s) => s.ctx);
  const toastMsg = useStore((s) => s.toast);

  useEffect(() => {
    void refreshContext();
    connectLive();
    const off = onLive((e) => {
      if (e.type === "nudge" || e.type === "mutation" || e.type === "ritual") void refreshContext();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey || e.altKey) return;
      const idx = Number(e.key);
      if (idx >= 1 && idx <= NAV.length) navigate(NAV[idx - 1]!.key);
    };
    window.addEventListener("keydown", onKey);
    if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("/sw.js").catch(() => {});
    return () => {
      off();
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => {
    const theme = ctx?.prefs.theme ?? "system";
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.setAttribute("data-theme", theme === "system" ? (mq.matches ? "dark" : "light") : theme);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [ctx?.prefs.theme]);

  const unread = ctx?.counts.unreadNudges ?? 0;
  const Page = { now: NowView, day: DayView, tasks: TasksView, memory: MemoryView, people: PeopleView, rituals: RitualsView, settings: SettingsView }[view] ?? NowView;

  return (
    <div className="shell">
      <nav className="rail" aria-label="Primary">
        <div className="brand">
          <img className="brand-mark" src="/icons/icon.svg" alt="" />
          <span className="brand-name">Kairos</span>
          <span className="brand-mode" data-mode={ctx?.mode}>{ctx?.mode === "claude" ? "claude" : ctx ? "local" : ""}</span>
        </div>
        {NAV.map((n, i) => (
          <button key={n.key} className="nav-btn" aria-current={view === n.key ? "page" : undefined} onClick={() => navigate(n.key)}>
            <n.icon />
            <span>{n.label}</span>
            {n.key === "now" && unread > 0 && <span className="badge accent">{unread}</span>}
            {n.key === "tasks" && (ctx?.counts.overdue ?? 0) > 0 && <span className="badge danger">{ctx!.counts.overdue}</span>}
            <span className="kbd" style={{ marginLeft: n.key === "now" && unread ? 6 : "auto", opacity: 0.6 }}>{i + 1}</span>
          </button>
        ))}
        <div className="rail-foot">
          <span><span className="kbd">⌘K</span> talk to Kairos</span>
          <span><span className="kbd">1–7</span> switch views</span>
        </div>
      </nav>
      <main className="main">
        <Page />
      </main>
      <Composer />
      <FocusOverlay />
      {toastMsg && <div className="toast" role="status">{toastMsg}</div>}
      {ctx && !ctx.prefs.onboarded && <Onboarding onDone={() => setState((s) => (s.ctx ? { ctx: { ...s.ctx, prefs: { ...s.ctx.prefs, onboarded: true } } } : {}))} />}
    </div>
  );
}
