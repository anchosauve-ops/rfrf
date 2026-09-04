import type { Payroll, Person } from "@core/types";
import { fmtHM, formatMoney } from "@core/worklog";
import { api, emitLocal } from "../lib/api";
import { runCommand, useNow, useResource, useStore, toast } from "../lib/store";
import { relDay } from "../lib/time";
import { PayrollCard } from "../components/PayrollCard";

type P = Person & { staleness: number };
interface TeamRow { person: Person; week: Payroll; month: Payroll; all: Payroll; lastLog?: string; lastImportAt?: string; summary: string }

export function PeopleView() {
  const { data, reload } = useResource<P[]>("/people", ["person"]);
  const { data: team } = useResource<TeamRow[]>("/team", ["person", "worklog"]);
  const now = useNow(60_000);
  const tz = useStore((s) => s.ctx?.prefs.timezone);
  const people = [...(data ?? [])].sort((a, b) => b.staleness - a.staleness);
  const touch = async (p: Person) => { await api.post(`/people/${p.id}/touch`); emitLocal({ type: "mutation", entity: "person" }); reload(); };
  const drifting = people.filter((p) => p.staleness >= 1);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="display" style={{ fontSize: 36 }}>People</h1>
          <p className="sub">{people.length} people · {drifting.length ? `${drifting.length} drifting past their cadence` : "nobody drifting"}</p>
        </div>
        <button className="btn primary" onClick={() => runCommand("add person ")}>+ Add someone</button>
      </div>
      {(team?.length ?? 0) > 0 && (
        <>
          <h2 className="section">Team <span className="muted" style={{ fontWeight: 400, letterSpacing: 0 }}>hours and pay, weeks run Sunday to Saturday</span></h2>
          <div className="stack">
            {team!.map((r) => (
              <div className="card" key={r.person.id}>
                <div className="teamrow">
                  <div>
                    <div style={{ fontWeight: 600 }}>{r.person.name} <span className="muted small">· {formatMoney(r.person.hourlyRate!, r.person.currency ?? "USD")}/h{r.person.expectedWeeklyHours ? ` · expects ${r.person.expectedWeeklyHours}h/wk` : ""}</span></div>
                    <div className="muted small">This week {fmtHM(r.week.totalMinutes)} · this month {fmtHM(r.month.totalMinutes)} · all time {fmtHM(r.all.totalMinutes)} ({formatMoney(r.all.amount, r.all.currency)}){r.lastLog ? ` · last logged ${r.lastLog}` : " · no hours yet"}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div className="amt">{formatMoney(r.week.amount, r.week.currency)}</div>
                    <div className="muted small">this week</div>
                  </div>
                </div>
                <PayrollCard payroll={r.month} />
                <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                  <button className="btn sm" onClick={() => { const v = prompt(`Hourly rate for ${r.person.name} (${r.person.currency ?? "USD"})`, String(r.person.hourlyRate)); if (v && !Number.isNaN(Number(v))) api.patch(`/people/${r.person.id}`, { hourlyRate: Number(v) }).then(() => { emitLocal({ type: "mutation", entity: "person" }); toast("Rate updated"); }); }}>Change rate</button>
                  <button className="btn sm" onClick={() => { const v = prompt(`Expected hours per week for ${r.person.name}`, String(r.person.expectedWeeklyHours ?? 40)); if (v && !Number.isNaN(Number(v))) api.patch(`/people/${r.person.id}`, { expectedWeeklyHours: Number(v) }).then(() => emitLocal({ type: "mutation", entity: "person" })); }}>Expected hours</button>
                  <button className="btn sm ghost" onClick={() => runCommand(`${r.person.name} worked `)}>Log a day</button>
                  <button className="btn sm ghost" onClick={() => runCommand(`payroll for ${r.person.name} all time`)}>All time</button>
                </div>
              </div>
            ))}
          </div>
          <h2 className="section">Everyone</h2>
        </>
      )}
      {people.length === 0 && <div className="empty"><span className="serif">Nobody yet.</span>Say “met Priya, colleague from design, every 2 weeks” and I'll keep the thread alive.</div>}
      <div className="people-grid">
        {people.map((p) => {
          const pct = Math.min(100, Math.round(p.staleness * 100));
          const color = p.staleness >= 1.25 ? "var(--danger)" : p.staleness >= 0.8 ? "var(--accent)" : "var(--ok)";
          return (
            <div className="person" key={p.id}>
              <div className="ring" style={{ ["--pct" as string]: p.cadenceDays ? pct : 0, ["--ring-color" as string]: color }}><span>{p.name[0]}</span></div>
              <div style={{ minWidth: 0 }}>
                <div className="n">{p.name}</div>
                <div className="r">
                  {p.relation ? `${p.relation} · ` : ""}
                  {p.lastContactAt ? `last ${relDay(p.lastContactAt, now, tz)}` : "never logged"}
                  {p.cadenceDays ? ` · every ${p.cadenceDays}d` : ""}
                </div>
                {p.notes && <div className="r" style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>{p.notes.split("\n").slice(-2).join("\n")}</div>}
              </div>
              <div className="acts">
                <button className="btn sm" onClick={() => void touch(p)}>In touch today</button>
                <button className="btn sm ghost" onClick={() => runCommand(`reach out to ${p.name} tomorrow`)}>Plan a touch</button>
                {!p.hourlyRate && <button className="btn sm ghost" title="Track hours and pay for this person" onClick={() => runCommand(`${p.name}'s rate is `)}>Works for me</button>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
