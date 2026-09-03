import { useMemo } from "react";
import type { Plan, PlanBlock } from "@core/types";
import { fmtLong, fmtTime, minutes } from "../lib/time";
import { navigate, runCommand, useNow, useResource, useStore } from "../lib/store";
import { Nudges } from "../components/Nudges";
import { EnergyDot } from "../components/Cards";
import { I } from "../components/Icons";

function greeting(now: Date, tz: string | undefined, name: string): { g: string; em: string } {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(now));
  const g = h < 5 ? "Still up" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  return { g, em: name ? `, ${name}.` : "." };
}

export function NowView() {
  const ctx = useStore((s) => s.ctx);
  const now = useNow(20_000);
  const tz = ctx?.prefs.timezone;
  const { data: plan } = useResource<Plan>("/plan", ["plan", "task", "event"]);
  const blocks = useMemo(() => (plan?.blocks ?? []).filter((b) => b.kind !== "buffer"), [plan]);
  const t = now.getTime();
  const current = blocks.find((b) => new Date(b.start).getTime() <= t && new Date(b.end).getTime() > t);
  const next = blocks.find((b) => new Date(b.start).getTime() > t && b.kind !== "free" && b.kind !== "break");
  const { g, em } = greeting(now, tz, ctx?.prefs.name ?? "");
  const pct = current ? Math.min(100, Math.round(((t - new Date(current.start).getTime()) / (new Date(current.end).getTime() - new Date(current.start).getTime())) * 100)) : 0;

  return (
    <div className="page">
      <div className="greeting">
        <div className="date">{fmtLong(now, tz)} · {fmtTime(now, tz)}</div>
        <h1 className="display">{g}<em>{em}</em></h1>
        <p className="sub">
          {ctx ? `${ctx.counts.openTasks} open · ${ctx.counts.overdue ? `${ctx.counts.overdue} overdue · ` : ""}${ctx.counts.todayEvents} event${ctx.counts.todayEvents === 1 ? "" : "s"} today` : "Loading your world…"}
          {ctx?.mode === "local" && <span> · <button className="btn sm ghost" style={{ padding: "0 4px" }} onClick={() => navigate("settings")}>running on Local Mind</button></span>}
        </p>
      </div>

      <Nudges />

      <div className="now-strip">
        <div className="card now-block">
          <div className="label">{current ? "Now" : "Up next"}</div>
          {current || next ? (
            <Block b={(current ?? next)!} tz={tz} />
          ) : (
            <>
              <div className="title">Nothing on the clock.</div>
              <div className="meta">{plan ? "The rest of the day is yours." : "No plan yet for today."}</div>
              {!plan && <button className="btn accent" style={{ marginTop: 14 }} onClick={() => runCommand("plan my day")}><I.spark /> Plan my day</button>}
            </>
          )}
          {current && (
            <>
              <div className="progress"><i style={{ width: `${pct}%` }} /></div>
              {current.kind === "task" && (
                <div className="row" style={{ marginTop: 12, gap: 6 }}>
                  <button className="btn sm" onClick={() => runCommand(`focus for ${Math.max(10, Math.round((new Date(current.end).getTime() - t) / 60000))} on ${current.title}`)}><I.play /> Focus</button>
                  <button className="btn sm ghost" onClick={() => runCommand(`done with ${current.title}`)}>Done</button>
                </div>
              )}
            </>
          )}
        </div>
        <div className="card now-block">
          <div className="label">{current ? "Then" : "After that"}</div>
          {(() => {
            const after = current ? next : blocks.find((b) => new Date(b.start).getTime() > t && b !== next && b.kind !== "free" && b.kind !== "break");
            return after ? <Block b={after} tz={tz} compact /> : <div className="title" style={{ fontSize: 22 }}>Open.</div>;
          })()}
        </div>
      </div>

      {plan && (
        <div className="stats">
          <Stat v={minutes(plan.stats.focusMin)} l="focus" />
          <Stat v={minutes(plan.stats.meetingMin)} l="meetings" />
          <Stat v={`${plan.stats.loadPct}%`} l="load" />
          <Stat v={String(plan.unscheduled.length)} l="didn't fit" />
        </div>
      )}

      <h2 className="section">Today <button className="btn sm ghost" style={{ marginLeft: "auto" }} onClick={() => runCommand("plan my day")}><I.refresh /> Replan</button></h2>
      {blocks.length ? (
        <div className="card plan-list" style={{ padding: "6px 12px" }}>
          {blocks.map((b) => {
            const s = new Date(b.start).getTime();
            const e = new Date(b.end).getTime();
            return (
              <div key={b.id} className={`plan-row ${s <= t && e > t ? "now" : e <= t ? "past" : ""}`} data-kind={b.kind} title={b.reason}>
                <span className="time">{fmtTime(b.start, tz)}–{fmtTime(b.end, tz)}</span>
                <span className="name"><EnergyDot e={b.energy} /><span className="t">{b.title}{b.part ? ` (${b.part[0]}/${b.part[1]})` : ""}</span></span>
                <span className="why">{b.reason}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="empty"><span className="serif">The day is a blank page.</span>Add a task or two, then ask me to plan it.</div>
      )}
      {plan && plan.unscheduled.length > 0 && (
        <>
          <h2 className="section">Didn't make the cut</h2>
          <div className="card" style={{ padding: "8px 16px" }}>
            {plan.unscheduled.map((u) => (
              <div key={u.taskId} className="row between" style={{ padding: "6px 0" }}>
                <span>{u.title}</span>
                <span className="muted small">{u.reason}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Block({ b, tz, compact }: { b: PlanBlock; tz?: string; compact?: boolean }) {
  return (
    <>
      <div className="title" style={compact ? { fontSize: 22 } : undefined}>{b.title}</div>
      <div className="meta row" style={{ gap: 8 }}>
        <EnergyDot e={b.energy} />
        {fmtTime(b.start, tz)}–{fmtTime(b.end, tz)}
        {b.kind === "event" && <span className="badge">event</span>}
      </div>
      {b.reason && !compact && <div className="reason">{b.reason}</div>}
    </>
  );
}
function Stat({ v, l }: { v: string; l: string }) {
  return <div className="stat"><div className="v">{v}</div><div className="l">{l}</div></div>;
}
