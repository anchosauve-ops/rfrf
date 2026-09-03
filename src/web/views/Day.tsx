import { useMemo, useState } from "react";
import type { Plan, PlanBlock } from "@core/types";
import { dayKeyLocal, fmtLong, fmtTime, minuteOfDay, minutes } from "../lib/time";
import { api, emitLocal } from "../lib/api";
import { runCommand, useNow, useResource, useStore } from "../lib/store";
import { I } from "../components/Icons";

const START_H = 6;
const END_H = 23;
const PX_PER_MIN = 80 / 60;

export function DayView() {
  const ctx = useStore((s) => s.ctx);
  const tz = ctx?.prefs.timezone;
  const now = useNow(30_000);
  const [offset, setOffset] = useState(0);
  const [sel, setSel] = useState<PlanBlock>();
  const date = useMemo(() => new Date(now.getTime() + offset * 86400_000), [now, offset]);
  const key = dayKeyLocal(date, tz);
  const { data: plan, reload } = useResource<Plan>(`/plan?date=${key}`, ["plan", "task", "event"], [key]);
  const isToday = offset === 0;
  const nowMin = minuteOfDay(now, tz);

  const replan = async () => {
    await api.post("/plan", { date: key });
    emitLocal({ type: "mutation", entity: "plan" });
    reload();
  };

  const hours = Array.from({ length: END_H - START_H }, (_, i) => START_H + i);
  const top = (iso: string) => (Math.max(START_H * 60, minuteOfDay(new Date(iso), tz)) - START_H * 60) * PX_PER_MIN;
  const height = (a: string, b: string) => Math.max(16, (Math.min(END_H * 60, minuteOfDay(new Date(b), tz)) - Math.max(START_H * 60, minuteOfDay(new Date(a), tz))) * PX_PER_MIN - 2);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="display" style={{ fontSize: 36 }}>{isToday ? "Today" : offset === 1 ? "Tomorrow" : offset === -1 ? "Yesterday" : fmtLong(date, tz)}</h1>
          <p className="sub">{fmtLong(date, tz)}{plan ? ` · ${minutes(plan.stats.focusMin)} focus · ${minutes(plan.stats.meetingMin)} meetings · ${plan.stats.loadPct}% load` : ""}</p>
        </div>
        <div className="day-nav">
          <button className="btn icon" onClick={() => setOffset(offset - 1)} aria-label="Previous day"><I.left /></button>
          <button className="btn" onClick={() => setOffset(0)} disabled={isToday}>Today</button>
          <button className="btn icon" onClick={() => setOffset(offset + 1)} aria-label="Next day"><I.right /></button>
          <button className="btn primary" onClick={() => void replan()}><I.refresh /> Replan</button>
        </div>
      </div>

      <div className="legend" style={{ marginBottom: 12 }}>
        <span><i className="dot deep" /> deep</span><span><i className="dot light" /> light</span><span><i className="dot admin" /> admin</span><span><i className="dot social" /> social</span>
        <span style={{ marginLeft: "auto" }}>click a block to see why it's there</span>
      </div>

      <div className="card" style={{ padding: "8px 8px 8px 0" }}>
        <div className="timeline">
          <div className="tl-hours">{hours.map((h) => <div className="tl-hour" key={h}>{h % 12 === 0 ? 12 : h % 12}{h < 12 ? "a" : "p"}</div>)}</div>
          <div className="tl-canvas" style={{ height: hours.length * 80 }}>
            {hours.map((h, i) => <div className="tl-line" key={h} style={{ top: i * 80 }} />)}
            {isToday && nowMin >= START_H * 60 && nowMin <= END_H * 60 && <div className="tl-now" style={{ top: (nowMin - START_H * 60) * PX_PER_MIN }} />}
            {(plan?.blocks ?? []).map((b) => (
              <div
                key={b.id}
                className={`tl-block ${sel?.id === b.id ? "selected" : ""} ${height(b.start, b.end) < 30 ? "compact" : ""}`}
                data-kind={b.kind}
                data-energy={b.energy}
                style={{ top: top(b.start), height: height(b.start, b.end) }}
                onClick={() => setSel(sel?.id === b.id ? undefined : b)}
                title={b.reason}
              >
                <div className="bt">{b.title}{b.part ? ` (${b.part[0]}/${b.part[1]})` : ""}</div>
                {height(b.start, b.end) > 34 && <div className="bm">{fmtTime(b.start, tz)}–{fmtTime(b.end, tz)}</div>}
              </div>
            ))}
          </div>
        </div>
      </div>

      {sel && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="row between">
            <div>
              <div style={{ fontWeight: 600, fontSize: 17 }}>{sel.title}</div>
              <div className="muted small">{fmtTime(sel.start, tz)}–{fmtTime(sel.end, tz)} · {sel.kind}{sel.energy ? ` · ${sel.energy}` : ""}</div>
            </div>
            {sel.kind === "task" && (
              <div className="row" style={{ gap: 6 }}>
                <button className="btn sm" onClick={() => runCommand(`focus for ${Math.round((new Date(sel.end).getTime() - new Date(sel.start).getTime()) / 60000)} on ${sel.title}`)}><I.play /> Focus</button>
                <button className="btn sm" onClick={() => runCommand(`move ${sel.title} to tomorrow`)}>Push to tomorrow</button>
                <button className="btn sm primary" onClick={() => runCommand(`done with ${sel.title}`)}>Done</button>
              </div>
            )}
          </div>
          {sel.reason && <div className="evidence" style={{ marginTop: 12 }}>Why here: {sel.reason}</div>}
        </div>
      )}

      {plan && plan.unscheduled.length > 0 && (
        <>
          <h2 className="section">Didn't fit</h2>
          <div className="card" style={{ padding: "8px 16px" }}>
            {plan.unscheduled.map((u) => (
              <div key={u.taskId} className="row between" style={{ padding: "6px 0" }}>
                <span>{u.title}</span><span className="muted small">{u.reason}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
