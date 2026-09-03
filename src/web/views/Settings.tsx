import { useEffect, useState } from "react";
import type { EnergySlot, Preferences } from "@core/types";
import { api, emitLocal } from "../lib/api";
import { refreshContext, toast, useStore } from "../lib/store";
import { hhmmToMin, minToHHMM } from "../lib/time";

type Prefs = Preferences & { hasApiKey?: boolean; apiKeySource?: string | null };
const MODELS = ["claude-opus-5", "claude-sonnet-5", "claude-fable-5-1", "claude-opus-4-8", "claude-haiku-4-5"];

export function SettingsView() {
  const ctx = useStore((s) => s.ctx);
  const [p, setP] = useState<Prefs>();
  const [key, setKey] = useState("");
  useEffect(() => { api.get<Prefs>("/prefs").then(setP).catch(() => {}); }, [ctx?.prefs]);
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [p?.timezone ?? "UTC"];

  const save = async (patch: Partial<Preferences> & { apiKey?: string | null }) => {
    const next = await api.put<Prefs>("/prefs", patch);
    setP(next);
    await refreshContext();
    emitLocal({ type: "mutation", entity: "prefs" });
    toast("Saved");
  };
  const exportAll = async () => {
    const data = await api.get<unknown>("/export");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `kairos-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  };
  const importAll = async (file: File) => {
    const data = JSON.parse(await file.text()) as unknown;
    const r = await api.post<{ imported: Record<string, number> }>("/import", data);
    for (const e of ["task", "event", "memory", "person"]) emitLocal({ type: "mutation", entity: e });
    toast(`Imported ${Object.entries(r.imported).map(([k, v]) => `${v} ${k}`).join(", ") || "nothing new"}`);
  };

  if (!p) return <div className="page"><p className="muted">Loading…</p></div>;
  const setSlot = (i: number, patch: Partial<EnergySlot>) => save({ energyCurve: p.energyCurve.map((s, j) => (j === i ? { ...s, ...patch } : s)) });

  return (
    <div className="page">
      <div className="page-head"><div><h1 className="display" style={{ fontSize: 36 }}>Settings</h1><p className="sub">Everything lives in a single SQLite file on this machine. Export it any time.</p></div></div>

      <h2 className="section">Brain</h2>
      <div className="card stack" style={{ gap: 14 }}>
        <div className="row between">
          <div><div style={{ fontWeight: 600 }}>{p.hasApiKey ? `Claude · ${p.model}` : "Local Mind"}</div><div className="muted small">{p.hasApiKey ? `Key from ${p.apiKeySource === "env" ? "environment" : "settings"}. Conversations go to Anthropic; your data stays here.` : "Deterministic planner and parser. No network. Add a key for open conversation and judgment."}</div></div>
          <span className={`badge ${p.hasApiKey ? "accent" : ""}`}>{p.hasApiKey ? "model on" : "offline"}</span>
        </div>
        <div className="grid-2">
          <label className="field"><span>Anthropic API key</span><input className="input" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={p.hasApiKey ? "•••••••• (set)" : "sk-ant-…"} /></label>
          <label className="field"><span>Model</span><select className="select" value={p.model} onChange={(e) => void save({ model: e.target.value })}>{[...new Set([p.model, ...MODELS])].map((m) => <option key={m}>{m}</option>)}</select></label>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn primary sm" disabled={!key.trim()} onClick={() => { void save({ apiKey: key.trim() }); setKey(""); }}>Save key</button>
          {p.hasApiKey && p.apiKeySource === "settings" && <button className="btn sm danger" onClick={() => void save({ apiKey: null })}>Remove key</button>}
          <label className="row" style={{ gap: 8, marginLeft: "auto" }}><span className="small muted">Autonomy</span>
            <select className="select" style={{ width: 160 }} value={p.autonomy} onChange={(e) => void save({ autonomy: e.target.value as Preferences["autonomy"] })}><option value="act">act, then tell me</option><option value="ask">ask before destructive</option></select>
          </label>
        </div>
      </div>

      <h2 className="section">You</h2>
      <div className="card grid-2">
        <label className="field"><span>Name</span><input className="input" defaultValue={p.name} onBlur={(e) => e.target.value !== p.name && void save({ name: e.target.value })} /></label>
        <label className="field"><span>Timezone</span><select className="select" value={p.timezone} onChange={(e) => void save({ timezone: e.target.value })}>{zones.map((z) => <option key={z}>{z}</option>)}</select></label>
        <label className="field"><span>Workday starts</span><input className="input" type="time" value={minToHHMM(p.workdayStartMin)} onChange={(e) => void save({ workdayStartMin: hhmmToMin(e.target.value) })} /></label>
        <label className="field"><span>Workday ends</span><input className="input" type="time" value={minToHHMM(p.workdayEndMin)} onChange={(e) => void save({ workdayEndMin: hhmmToMin(e.target.value) })} /></label>
        <label className="field"><span>Work days</span>
          <div className="row" style={{ gap: 4 }}>{["S", "M", "T", "W", "T", "F", "S"].map((d, i) => <button key={i} className={`btn sm ${p.workDays.includes(i) ? "primary" : ""}`} onClick={() => void save({ workDays: p.workDays.includes(i) ? p.workDays.filter((x) => x !== i) : [...p.workDays, i].sort() })}>{d}</button>)}</div>
        </label>
        <label className="field"><span>Theme</span><select className="select" value={p.theme} onChange={(e) => void save({ theme: e.target.value as Preferences["theme"] })}><option value="system">system</option><option value="light">light</option><option value="dark">dark</option></select></label>
        <label className="field"><span>Focus block (min)</span><input className="input" type="number" defaultValue={p.focusBlockMin} onBlur={(e) => void save({ focusBlockMin: Number(e.target.value) || 90 })} /></label>
        <label className="field"><span>Break (min)</span><input className="input" type="number" defaultValue={p.breakMin} onBlur={(e) => void save({ breakMin: Number(e.target.value) || 10 })} /></label>
        <label className="row" style={{ gap: 10, gridColumn: "1 / -1" }}><button className="switch" role="switch" aria-checked={p.voice} onClick={() => void save({ voice: !p.voice })} /><span>Read replies aloud</span></label>
      </div>

      <h2 className="section">Energy curve</h2>
      <div className="card">
        <p className="muted small" style={{ marginTop: 0 }}>The planner puts deep work where you're sharp and admin where you're not. Tell it when that is.</p>
        <div className="stack">
          {p.energyCurve.map((s, i) => (
            <div className="row" key={i} style={{ gap: 8 }}>
              <input className="input" type="time" style={{ width: 120 }} value={minToHHMM(s.fromMin)} onChange={(e) => void setSlot(i, { fromMin: hhmmToMin(e.target.value) })} />
              <span className="muted">to</span>
              <input className="input" type="time" style={{ width: 120 }} value={minToHHMM(s.toMin)} onChange={(e) => void setSlot(i, { toMin: hhmmToMin(e.target.value) })} />
              <select className="select" style={{ width: 130 }} value={s.best} onChange={(e) => void setSlot(i, { best: e.target.value as EnergySlot["best"] })}><option value="deep">deep</option><option value="light">light</option><option value="admin">admin</option><option value="social">social</option></select>
              <button className="btn icon ghost" onClick={() => void save({ energyCurve: p.energyCurve.filter((_, j) => j !== i) })} aria-label="Remove">×</button>
            </div>
          ))}
          <button className="btn sm" style={{ alignSelf: "flex-start" }} onClick={() => void save({ energyCurve: [...p.energyCurve, { fromMin: 19 * 60, toMin: 21 * 60, best: "light" }] })}>+ Add window</button>
        </div>
      </div>

      <h2 className="section">Your data</h2>
      <div className="card row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button className="btn" onClick={() => void exportAll()}>Export everything (JSON)</button>
        <label className="btn">Import JSON<input type="file" accept="application/json" hidden onChange={(e) => e.target.files?.[0] && void importAll(e.target.files[0])} /></label>
        <button className="btn ghost" onClick={() => api.post("/demo").then(() => { for (const x of ["task", "event", "memory", "person"]) emitLocal({ type: "mutation", entity: x }); toast("Demo day loaded"); })}>Load demo day</button>
        <span className="muted small" style={{ marginLeft: "auto" }}>Kairos v0.1 · local-first · MIT</span>
      </div>
    </div>
  );
}
