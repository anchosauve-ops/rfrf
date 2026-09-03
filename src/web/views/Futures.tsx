import { useState } from "react";
import type { CouncilVerdict, Goal, RiskReport } from "@core/types";
import { api } from "../lib/api";
import { runCommand, useResource, useStore } from "../lib/store";
import { CouncilCard, GoalsCard, RiskCard } from "../components/SymbiosisCards";
import { I } from "../components/Icons";

type GoalRow = Goal & { alignment: { goalId: string; title: string; focusMin: number; share: number } | null };

export function FuturesView() {
  const mode = useStore((s) => s.ctx?.mode);
  const [days, setDays] = useState(7);
  const { data: report, loading } = useResource<RiskReport>(`/futures?days=${days}`, ["task", "event", "plan", "prefs", "ledger"], [days]);
  const { data: goals } = useResource<GoalRow[]>("/goals", ["goal", "task", "plan"]);
  const [verdict, setVerdict] = useState<CouncilVerdict>();
  const [question, setQuestion] = useState("");
  const [convening, setConvening] = useState(false);

  const convene = async () => {
    setConvening(true);
    try {
      setVerdict(await api.post<CouncilVerdict>("/council", { question: question.trim() || undefined }));
    } finally {
      setConvening(false);
    }
  };

  const danger = report?.risks.filter((r) => r.level === "danger").length ?? 0;
  const watch = report?.risks.filter((r) => r.level === "watch").length ?? 0;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="display" style={{ fontSize: 36 }}>Futures</h1>
          <p className="sub">
            {report ? `${report.runs} simulated weeks · ${danger ? `${danger} deadline${danger > 1 ? "s" : ""} in danger` : "no deadline in danger"}${watch ? ` · ${watch} to watch` : ""} · ${Math.round(report.capacity.ratio * 100)}% of focus time committed` : loading ? "Simulating…" : ""}
          </p>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {[5, 7, 14].map((d) => <button key={d} className={`btn sm ${days === d ? "primary" : ""}`} onClick={() => setDays(d)}>{d}d</button>)}
        </div>
      </div>

      {report && <RiskCard report={report} />}

      <h2 className="section">Where you're headed <button className="btn sm ghost" style={{ marginLeft: "auto" }} onClick={() => runCommand("goal: ")}>+ Goal</button></h2>
      <GoalsCard goals={goals ?? []} alignment={(goals ?? []).map((g) => g.alignment).filter((a): a is NonNullable<typeof a> => !!a)} />

      <h2 className="section">The council</h2>
      <div className="card">
        <p className="muted small" style={{ margin: "0 0 10px" }}>
          Five perspectives argue about your week before you get advice: strategist, realist, guardian, connector, editor.
          {mode === "claude" ? " Each is a separate model call with its own charter, then a synthesis." : " Running deterministic critics; add an API key and each becomes a model with a charter."}
        </p>
        <form className="capture" onSubmit={(e) => { e.preventDefault(); void convene(); }}>
          <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Optional question, e.g. “should I take the Thursday offsite?”" aria-label="Council question" />
          <button className="btn primary sm" type="submit" disabled={convening}><I.spark /> {convening ? "Deliberating…" : "Convene"}</button>
        </form>
      </div>
      {verdict && <div style={{ marginTop: 12 }}><CouncilCard verdict={verdict} /></div>}
    </div>
  );
}
