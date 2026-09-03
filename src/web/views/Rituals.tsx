import type { Ritual, Watcher } from "@core/types";
import { api, emitLocal } from "../lib/api";
import { toast, useResource } from "../lib/store";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WATCH_HELP: Record<Watcher["kind"], (t: number) => string> = {
  overdue_tasks: (t) => `when a task is ≥ ${t} day${t === 1 ? "" : "s"} overdue`,
  stale_people: (t) => `when someone passes ${Math.round(t * 100)}% of their cadence`,
  overloaded_day: (t) => `when today's plan hits ${t}% load`,
  deadline_approaching: (t) => `when an important task is due within ${t}h and unplanned`,
  unplanned_day: () => `when the workday starts with no plan`,
  deadline_risk: (t) => `when an important deadline has ≥ ${Math.round(t * 100)}% simulated risk (Guardian may defer low-priority work)`,
  empty_estimate: () => `when tasks lack estimates`,
};

export function RitualsView() {
  const { data: rituals, reload } = useResource<Ritual[]>("/rituals", []);
  const { data: watchers, reload: reloadW } = useResource<Watcher[]>("/watchers", []);

  const saveR = async (r: Ritual, patch: Partial<Ritual>) => { await api.put(`/rituals/${r.id}`, patch); reload(); };
  const run = async (r: Ritual) => { await api.post(`/rituals/${r.id}/run`); emitLocal({ type: "nudge" }); toast(`${r.name} delivered to Now`); };
  const saveW = async (w: Watcher, patch: Partial<Watcher>) => { await api.put(`/watchers/${w.id}`, patch); reloadW(); };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="display" style={{ fontSize: 36 }}>Rituals</h1>
          <p className="sub">What I do on a schedule, and what I watch for in between. Both land on your Now page.</p>
        </div>
      </div>
      <h2 className="section">On a schedule</h2>
      <div className="stack">
        {(rituals ?? []).map((r) => (
          <div className="ritual" key={r.id}>
            <div>
              <div className="n">{r.name}</div>
              <div className="d">
                {r.rule.freq === "weekly" && r.rule.byWeekday ? `${r.rule.byWeekday.map((d) => DAYS[d]).join(", ")}` : "every day"} at {r.rule.time}
                {r.lastRunAt ? ` · last ran ${new Date(r.lastRunAt).toLocaleString()}` : " · hasn't run yet"}
              </div>
            </div>
            <input className="input" type="time" style={{ width: 120 }} value={r.rule.time ?? "08:00"} onChange={(e) => void saveR(r, { rule: { ...r.rule, time: e.target.value } })} aria-label={`${r.name} time`} />
            <button className="btn sm" onClick={() => void run(r)}>Run now</button>
            <button className="switch" role="switch" aria-checked={r.enabled} onClick={() => void saveR(r, { enabled: !r.enabled })} aria-label={`${r.name} enabled`} />
          </div>
        ))}
      </div>
      <h2 className="section">Watching for</h2>
      <div className="stack">
        {(watchers ?? []).map((w) => (
          <div className="ritual" key={w.id} style={{ gridTemplateColumns: "1fr auto auto" }}>
            <div>
              <div className="n">{w.name}</div>
              <div className="d">Nudges you {WATCH_HELP[w.kind](w.threshold)} · at most every {Math.round(w.cooldownMin / 60)}h{w.lastFiredAt ? ` · last ${new Date(w.lastFiredAt).toLocaleString()}` : ""}</div>
            </div>
            {w.kind !== "unplanned_day" && w.kind !== "empty_estimate" && (
              <input className="input" type="number" step={w.kind === "stale_people" ? 0.05 : 1} style={{ width: 90 }} value={w.threshold} onChange={(e) => void saveW(w, { threshold: Number(e.target.value) })} aria-label={`${w.name} threshold`} />
            )}
            <button className="switch" role="switch" aria-checked={w.enabled} onClick={() => void saveW(w, { enabled: !w.enabled })} aria-label={`${w.name} enabled`} />
          </div>
        ))}
      </div>
    </div>
  );
}
