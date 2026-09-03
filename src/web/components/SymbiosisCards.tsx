import type { Calibration, CouncilVerdict, Goal, LedgerEntry, RiskReport } from "@core/types";
import { runCommand, useStore } from "../lib/store";
import { api, emitLocal } from "../lib/api";
import { fmtDay } from "../lib/time";

const ENERGIES = ["deep", "light", "admin", "social"] as const;
const H = (h: number) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? "a" : "p"}`;

export function RiskCard({ report, compact }: { report: RiskReport; compact?: boolean }) {
  const tz = useStore((s) => s.ctx?.prefs.timezone);
  const risks = compact ? report.risks.filter((r) => r.level !== "safe").slice(0, 5) : report.risks;
  const maxLoad = Math.max(1.2, ...report.loadByDay.map((d) => d.load));
  return (
    <div className="acard">
      <div className="ct row between">
        <span>Futures · next {report.horizonDays} days · {report.runs} simulated weeks</span>
        <span className="mono">{Math.round(report.capacity.ratio * 100)}% of focus time committed</span>
      </div>
      {!compact && (
        <div style={{ margin: "6px 0 14px" }}>
          <div className="loadchart" role="img" aria-label="Expected load by day">
            <div className="cap" style={{ bottom: `${(1 / maxLoad) * 100}%` }} />
            {report.loadByDay.map((d) => (
              <div className="col" key={d.day} title={`${d.day}: ${Math.round(d.load * 100)}% load, ${d.meetingsMin} min meetings`}>
                <span className="val">{Math.round(d.load * 100)}%</span>
                <div className={`bar ${d.load > 1 ? "over" : d.load < 0.4 ? "light" : ""}`} style={{ height: `${Math.min(100, (d.load / maxLoad) * 100)}%` }} />
                <span className="lbl">{fmtDay(d.day + "T12:00:00Z", "UTC", { weekday: "short", month: undefined, day: undefined })}</span>
              </div>
            ))}
          </div>
          <div className="muted small" style={{ marginTop: 6 }}>Dashed line is 100% of the free time that exists after meetings and slack.</div>
        </div>
      )}
      {risks.length === 0 ? (
        <div className="muted small">No dated task is at meaningful risk.</div>
      ) : (
        <div>
          {risks.map((r) => (
            <div className="riskbar" key={r.taskId} data-level={r.level}>
              <div className="t">
                <b>{r.title}</b>
                <small>due {fmtDay(r.due, tz)} · expected {r.expectedDay === "beyond horizon" ? "after the horizon" : fmtDay(r.expectedDay + "T12:00:00Z", "UTC")} · <span className="level" data-level={r.level}>{r.level}</span></small>
              </div>
              <div className="track" aria-label={`${Math.round(r.pMiss * 100)}% chance of missing`}><i style={{ width: `${Math.max(2, r.pMiss * 100)}%` }} /></div>
              <div className="pct">{Math.round(r.pMiss * 100)}%</div>
            </div>
          ))}
        </div>
      )}
      {report.interventions.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="ct">Best moves, ranked by risk removed</div>
          {report.interventions.slice(0, compact ? 3 : 6).map((i) => (
            <div className="interv" key={i.id}>
              <div>
                <div>{i.title}</div>
                <div className="d">{i.detail}</div>
              </div>
              <div className="row" style={{ gap: 8 }}>
                <span className="delta">−{Math.round(i.riskDelta * 100)}% of risk</span>
                <button className="btn sm" onClick={() => runCommand(i.command)}>Do it</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function CouncilCard({ verdict }: { verdict: CouncilVerdict }) {
  return (
    <div className="acard">
      <div className="ct">Council · {verdict.mode === "claude" ? "five model perspectives" : "five deterministic critics"} · “{verdict.question}”</div>
      <div className="verdict">
        <div className="s">{verdict.synthesis}</div>
        <div className="d">{verdict.decision}</div>
      </div>
      <div style={{ marginTop: 8 }}>
        {verdict.findings.length === 0 && <div className="muted small">Nobody objected.</div>}
        {verdict.findings.map((f, i) => (
          <div className="finding" key={i} data-sev={f.severity}>
            <div className="who" data-label={f.severity}><b>{f.perspective}</b></div>
            <div>
              <div className="claim">{f.claim}</div>
              <div className="ev">{f.evidence}</div>
              {(f.suggestion || f.command) && (
                <div className="sug">
                  <span>{f.suggestion}</span>
                  {f.command && <button className="btn sm" onClick={() => runCommand(f.command!)}>Do it</button>}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function CalibrationCard({ calibration: c, stated, onAdopt }: { calibration: Calibration; stated?: { fromMin: number; toMin: number; best: string }[]; onAdopt?: () => void }) {
  const statedAt = (h: number) => stated?.find((s) => h * 60 >= s.fromMin && h * 60 < s.toMin)?.best;
  return (
    <div className="acard">
      <div className="ct">What the outcomes say · {c.sampleSize} completed tasks</div>
      {c.sampleSize < 5 ? (
        <div className="muted small">Not much to see yet. Finish a handful of tasks and the mirror starts to form.</div>
      ) : (
        <>
          <div className="small muted" style={{ marginBottom: 4 }}>Estimate bias (×1 = accurate; right of the line = you underestimate)</div>
          {ENERGIES.map((e) => {
            const b = c.estimateBias[e];
            const pct = Math.max(-1, Math.min(1, Math.log2(b.factor))); // −1..1 maps ×0.5..×2
            return (
              <div className="bias" key={e}>
                <span className="row" style={{ gap: 6 }}><i className={`dot ${e}`} />{e}</span>
                <div className="track" title={`×${b.factor} from ${b.n} tasks`}>
                  <i style={{ left: pct >= 0 ? "50%" : `${50 + pct * 50}%`, width: `${Math.abs(pct) * 50}%`, background: `var(--${e})`, opacity: b.n ? 1 : 0.3 }} />
                </div>
                <span className="n">×{b.factor.toFixed(2)} · n={b.n}</span>
              </div>
            );
          })}
          <div className="small muted" style={{ margin: "14px 0 6px" }}>When work actually gets done (darker = more) · dash marks your stated curve</div>
          <div className="hours" role="img" aria-label="Completion propensity by hour">
            {c.hourPropensity.map((v, h) => (
              <div key={h} className="h" style={{ ["--v" as string]: v }} data-stated={statedAt(h) ? "" : undefined} title={`${H(h)}: ${Math.round(v * 100)}%${statedAt(h) ? ` · stated ${statedAt(h)}` : ""}`} />
            ))}
          </div>
          <div className="hours" aria-hidden="true">{c.hourPropensity.map((_, h) => <div key={h} className="hl">{h % 3 === 0 ? H(h) : ""}</div>)}</div>
          <div className="grid-3" style={{ marginTop: 14 }}>
            <div className="metric"><div className="v">{c.planAdherence.n ? `${Math.round(c.planAdherence.rate * 100)}%` : "—"}</div><div className="l">done on the planned day</div></div>
            <div className="metric"><div className="v">{c.slipRate.n ? `${Math.round(c.slipRate.overall * 100)}%` : "—"}</div><div className="l">slip past due date</div></div>
            <div className="metric"><div className="v">{c.peakHours.deep.length ? c.peakHours.deep.slice(0, 2).map(H).join(" · ") : "—"}</div><div className="l">real deep-work hours</div></div>
          </div>
          {c.proposedCurve && (
            <div className="row between" style={{ marginTop: 14, padding: "10px 12px", borderRadius: 10, background: "var(--accent-soft)" }}>
              <div className="small">
                <b>Proposed energy curve:</b> {c.proposedCurve.map((s) => `${H(s.fromMin / 60)}–${H(s.toMin / 60)} ${s.best}`).join(" · ")}
              </div>
              {onAdopt && <button className="btn sm accent" onClick={onAdopt}>Adopt</button>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function GoalsCard({ goals, alignment }: { goals: Goal[]; alignment?: { goalId: string; title: string; focusMin: number; share: number }[] }) {
  const tz = useStore((s) => s.ctx?.prefs.timezone);
  const now = Date.now();
  return (
    <div className="acard">
      <div className="ct">Goals</div>
      {goals.map((g) => {
        const a = alignment?.find((x) => x.goalId === g.id);
        const expected = g.targetDate ? Math.min(1, Math.max(0, (now - new Date(g.createdAt).getTime()) / (new Date(g.targetDate).getTime() - new Date(g.createdAt).getTime()))) : undefined;
        return (
          <div className="goal" key={g.id}>
            <div style={{ minWidth: 0 }}>
              <div className="gt">{g.title}</div>
              <div className="gm">{g.horizon}{g.targetDate ? ` · by ${fmtDay(g.targetDate, tz)}` : ""}{a ? ` · ${a.focusMin} min this week (${Math.round(a.share * 100)}% of focus)` : ""}{g.status !== "active" ? ` · ${g.status}` : ""}</div>
              <div className="gp" title={expected !== undefined ? `Progress ${Math.round(g.progress * 100)}% vs ${Math.round(expected * 100)}% of time elapsed` : `${Math.round(g.progress * 100)}%`}>
                <i style={{ width: `${Math.round(g.progress * 100)}%` }} />
                {expected !== undefined && <b style={{ left: `${Math.round(expected * 100)}%` }} />}
              </div>
            </div>
            <div className="row" style={{ gap: 4 }}>
              <button className="btn sm ghost" title="+10%" onClick={() => api.patch(`/goals/${g.id}`, { progress: Math.min(1, g.progress + 0.1) }).then(() => emitLocal({ type: "mutation", entity: "goal" }))}>+10%</button>
              <button className="btn sm ghost" onClick={() => runCommand(`remind me to `)}>+ step</button>
            </div>
          </div>
        );
      })}
      {goals.length === 0 && <div className="muted small">No goals. Say “goal: …” to set one.</div>}
    </div>
  );
}

export function LedgerCard({ entries, onChange }: { entries: LedgerEntry[]; onChange?: () => void }) {
  const undo = async (e: LedgerEntry) => {
    await api.post(`/ledger/${e.id}/undo`);
    for (const x of ["ledger", "task", "plan", "prefs"]) emitLocal({ type: "mutation", entity: x });
    onChange?.();
  };
  return (
    <div className="acard">
      <div className="ct">Ledger · everything Kairos did on its own</div>
      {entries.length === 0 && <div className="muted small">Nothing autonomous yet. That's the default until you set autonomy to Guardian.</div>}
      {entries.map((e) => (
        <div className={`ledger-row ${e.undoneAt ? "undone" : ""}`} key={e.id}>
          <div>
            <div className="ls">{e.summary}</div>
            <div className="lr">{e.reason} · {new Date(e.createdAt).toLocaleString()} · via {e.origin}{e.undoneAt ? " · undone" : ""}</div>
          </div>
          {!e.undoneAt && <button className="btn sm" onClick={() => void undo(e)}>Undo</button>}
        </div>
      ))}
    </div>
  );
}
