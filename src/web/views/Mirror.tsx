import type { Calibration, LedgerEntry, Preferences } from "@core/types";
import { api, emitLocal } from "../lib/api";
import { refreshContext, toast, useResource } from "../lib/store";
import { CalibrationCard, LedgerCard } from "../components/SymbiosisCards";

interface MirrorData {
  calibration: Calibration;
  learned: string[];
  outcomes: number;
  prefs: Preferences;
  ledger: LedgerEntry[];
  alignment: { goalId: string; title: string; focusMin: number; share: number }[];
}

export function MirrorView() {
  const { data, reload } = useResource<MirrorData>("/mirror", ["task", "prefs", "ledger", "goal"]);
  const setPref = async (patch: Partial<Preferences>) => {
    await api.put("/prefs", patch);
    await refreshContext();
    emitLocal({ type: "mutation", entity: "prefs" });
    reload();
  };
  const adopt = async () => {
    await api.post("/mirror/adopt-curve");
    toast("Energy curve updated from your history. Undo is in the ledger.");
    await refreshContext();
    emitLocal({ type: "mutation", entity: "prefs" });
    emitLocal({ type: "mutation", entity: "ledger" });
    reload();
  };
  const backfill = async () => {
    const r = await api.post<{ backfilled: number }>("/outcomes/backfill");
    toast(`Learned from ${r.backfilled} past completions`);
    reload();
  };
  if (!data) return <div className="page"><p className="muted">Looking…</p></div>;
  const p = data.prefs;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="display" style={{ fontSize: 36 }}>Mirror</h1>
          <p className="sub">What I've learned about how you actually work, from {data.calibration.sampleSize} completed tasks. You can read all of it, and you can decide what I do with it.</p>
        </div>
        <button className="btn sm ghost" onClick={() => void backfill()}>Learn from past completions</button>
      </div>

      {data.learned.length > 0 && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="card-title">In plain words</div>
          <div className="stack" style={{ gap: 6 }}>
            {data.learned.map((l, i) => <div key={i} className="serif" style={{ fontSize: 19, lineHeight: 1.3 }}>{l}</div>)}
          </div>
        </div>
      )}

      <CalibrationCard calibration={data.calibration} stated={p.energyCurve} onAdopt={data.calibration.proposedCurve ? () => void adopt() : undefined} />

      <h2 className="section">What I'm allowed to do with it</h2>
      <div className="card stack" style={{ gap: 14 }}>
        <label className="row between" style={{ gap: 12 }}>
          <span><b>Use calibration in the planner</b><div className="muted small">Scale estimates by your measured bias per kind of work. Blocks show “~90m by your history”.</div></span>
          <button className="switch" role="switch" aria-checked={p.useCalibration} onClick={() => void setPref({ useCalibration: !p.useCalibration })} />
        </label>
        <label className="row between" style={{ gap: 12 }}>
          <span><b>Auto-tune my energy curve</b><div className="muted small">When the evidence is strong (25+ completions), adopt the learned curve automatically. Logged and undoable.</div></span>
          <button className="switch" role="switch" aria-checked={p.autoTuneCurve} onClick={() => void setPref({ autoTuneCurve: !p.autoTuneCurve })} />
        </label>
        <div className="row between" style={{ gap: 12 }}>
          <span><b>Autonomy</b><div className="muted small">Guardian mode lets Kairos push low-priority work to next week when a real deadline is at risk. Every action lands in the ledger with an Undo.</div></span>
          <select className="select" style={{ width: 220 }} value={p.autonomy} onChange={(e) => void setPref({ autonomy: e.target.value as Preferences["autonomy"] })}>
            <option value="ask">Ask before destructive</option>
            <option value="act">Act, then tell me</option>
            <option value="guardian">Guardian: intervene on risk</option>
          </select>
        </div>
      </div>

      <h2 className="section">Ledger</h2>
      <LedgerCard entries={data.ledger} onChange={reload} />

      {data.alignment.length > 0 && (
        <>
          <h2 className="section">Where the week's focus went</h2>
          <div className="card">
            {data.alignment.map((a) => (
              <div className="row between" key={a.goalId} style={{ padding: "6px 0" }}>
                <span>{a.title}</span>
                <span className="mono muted">{a.focusMin} min · {Math.round(a.share * 100)}%</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
