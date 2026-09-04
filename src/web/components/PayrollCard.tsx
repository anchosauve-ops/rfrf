import type { Payroll } from "@core/types";
import { fmtHM, formatMoney } from "@core/worklog";
import { runCommand } from "../lib/store";

const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
function dow(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

export function PayrollCard({ payroll: p, compact }: { payroll: Payroll; compact?: boolean }) {
  const max = Math.max(60, ...p.days.map((d) => d.minutes));
  return (
    <div className="acard payroll">
      <div className="ct row between">
        <span>{p.name} · {p.from === "0000-01-01" ? "all time" : `${p.from} → ${p.to}`}</span>
        <span className="mono">{formatMoney(p.rate, p.currency)}/h</span>
      </div>
      <div className="row" style={{ alignItems: "baseline", gap: 14 }}>
        <div className="serif" style={{ fontSize: 34, lineHeight: 1 }}>{formatMoney(p.amount, p.currency)}</div>
        <div className="muted">{fmtHM(p.totalMinutes)} logged{p.expectedWeeklyHours && p.weeks.length === 1 ? ` · expects ${p.expectedWeeklyHours}h/wk` : ""}</div>
      </div>
      {p.days.length > 0 && (
        <div className="paydays" role="img" aria-label="Hours per day">
          {p.days.slice(compact ? -14 : -62).map((d) => (
            <div className="payday" key={d.date} title={`${d.date}: ${fmtHM(d.minutes)}`}>
              <div className="bar" style={{ height: `${Math.max(3, (d.minutes / max) * 56)}px` }} />
              <div className="lbl">{DOW[dow(d.date)]}<br />{d.date.slice(8)}</div>
            </div>
          ))}
        </div>
      )}
      {p.weeks.length > 1 && (
        <ul style={{ marginTop: 8 }}>
          {p.weeks.map((w) => (
            <li key={w.start}><span className="time">wk {w.start.slice(5)}</span><span>{fmtHM(w.minutes)}</span><span className="muted small" style={{ marginLeft: "auto" }}>{formatMoney(w.amount, p.currency)}</span></li>
          ))}
        </ul>
      )}
      {p.days.length === 0 && <div className="muted small">No hours in this period yet.</div>}
      {!compact && (
        <div className="row" style={{ gap: 6, marginTop: 10 }}>
          <button className="btn sm" onClick={() => runCommand(`payroll for ${p.name} this month`)}>This month</button>
          <button className="btn sm" onClick={() => runCommand(`payroll for ${p.name} last week`)}>Last week</button>
          <button className="btn sm ghost" onClick={() => runCommand(`import timeproof for ${p.name}: `)}>Import hours</button>
        </div>
      )}
    </div>
  );
}
