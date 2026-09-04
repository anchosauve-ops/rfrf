import { useState } from "react";
import type { Card, Task, Event, PlanBlock } from "@core/types";
import { fmtTime, fmtDay, minutes, relDay } from "../lib/time";
import { runCommand, setState, useStore } from "../lib/store";
import { api, emitLocal } from "../lib/api";
import { I } from "./Icons";
import { CalibrationCard, CouncilCard, GoalsCard, LedgerCard, RiskCard } from "./SymbiosisCards";
import { PayrollCard } from "./PayrollCard";

export function EnergyDot({ e }: { e?: string }) {
  return e ? <i className={`dot ${e}`} title={e} /> : null;
}

function TaskLine({ t, now, tz, onDone }: { t: Task; now: Date; tz?: string; onDone?: () => void }) {
  const [busy, setBusy] = useState(false);
  const done = async () => {
    if (t.status !== "open" || busy) return;
    setBusy(true);
    try {
      await api.post(`/tasks/${t.id}/complete`);
      emitLocal({ type: "mutation", entity: "task" });
      onDone?.();
    } finally {
      setBusy(false);
    }
  };
  return (
    <li>
      <button className="check" aria-checked={t.status === "done"} role="checkbox" onClick={done} title="Mark done">
        {t.status === "done" && <I.check />}
      </button>
      <EnergyDot e={t.energy} />
      <span style={t.status === "done" ? { textDecoration: "line-through", color: "var(--ink-3)" } : undefined}>{t.title}</span>
      <span className="muted small" style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>
        {t.due ? `${new Date(t.due) < now && t.status === "open" ? "⚠ " : ""}${relDay(t.due, now, tz)}` : t.pinnedStart ? `${relDay(t.pinnedStart, now, tz)} ${fmtTime(t.pinnedStart, tz)}` : t.estimateMin ? minutes(t.estimateMin) : ""}
      </span>
    </li>
  );
}

function EventLine({ e, tz }: { e: Event; tz?: string }) {
  return (
    <li>
      <span className="time">{e.allDay ? "all day" : fmtTime(e.start, tz)}</span>
      <span>{e.title}</span>
      {e.location && <span className="muted small">· {e.location}</span>}
    </li>
  );
}

function PlanLines({ blocks, tz, now }: { blocks: PlanBlock[]; tz?: string; now: Date }) {
  return (
    <ul>
      {blocks
        .filter((b) => b.kind !== "buffer")
        .map((b) => (
          <li key={b.id} style={new Date(b.end) < now ? { opacity: 0.5 } : undefined} title={b.reason}>
            <span className="time">{fmtTime(b.start, tz)}</span>
            <EnergyDot e={b.energy} />
            <span style={b.kind === "break" || b.kind === "free" ? { color: "var(--ink-3)", fontStyle: "italic" } : b.kind === "event" ? { fontWeight: 500 } : undefined}>
              {b.title}
              {b.part && <span className="muted small"> ({b.part[0]}/{b.part[1]})</span>}
            </span>
          </li>
        ))}
    </ul>
  );
}

export function CardView({ card, now }: { card: Card; now: Date }) {
  const tz = useStore((s) => s.ctx?.prefs.timezone);
  switch (card.type) {
    case "text":
      return <div className="acard" style={{ whiteSpace: "pre-wrap" }}>{card.markdown}</div>;
    case "tasks":
      return (
        <div className="acard">
          {card.title && <div className="ct">{card.title}</div>}
          <ul>{card.tasks.map((t) => <TaskLine key={t.id} t={t} now={now} tz={tz} />)}</ul>
        </div>
      );
    case "events":
      return (
        <div className="acard">
          {card.title && <div className="ct">{card.title}</div>}
          <ul>{card.events.map((e) => <EventLine key={e.id} e={e} tz={tz} />)}</ul>
        </div>
      );
    case "plan":
      return (
        <div className="acard">
          <div className="ct">
            Plan · {fmtDay(card.plan.date + "T12:00:00Z", "UTC")} · {card.plan.stats.loadPct}% load · {minutes(card.plan.stats.focusMin)} focus
          </div>
          <PlanLines blocks={card.plan.blocks} tz={tz} now={now} />
          {card.plan.unscheduled.length > 0 && (
            <div className="muted small" style={{ marginTop: 8 }}>
              Didn't fit: {card.plan.unscheduled.map((u) => u.title).join(", ")}
            </div>
          )}
        </div>
      );
    case "brief":
      return (
        <div className="acard brief-card">
          <div className="g">{card.brief.greeting}</div>
          <div className="h">{card.brief.headline}</div>
          {card.brief.sections.map((s) => (
            <div className="sec" key={s.id}>
              <h4>{s.title}</h4>
              {s.lines.map((l, i) => <p key={i}>{l}</p>)}
            </div>
          ))}
        </div>
      );
    case "memories":
      return (
        <div className="acard">
          {card.title && <div className="ct">{card.title}</div>}
          <ul>
            {card.memories.map((m) => (
              <li key={m.id}>
                <span className={`badge`}>{m.kind}</span>
                <span>{m.text}</span>
                <span className="muted small" style={{ marginLeft: "auto" }}>{m.source} · {Math.round(m.confidence * 100)}%</span>
              </li>
            ))}
          </ul>
        </div>
      );
    case "people":
      return (
        <div className="acard">
          {card.title && <div className="ct">{card.title}</div>}
          <ul>
            {card.people.map((p) => (
              <li key={p.id}>
                <span style={{ fontWeight: 500 }}>{p.name}</span>
                {p.relation && <span className="muted small">{p.relation}</span>}
                <button className="btn sm ghost" style={{ marginLeft: "auto" }} onClick={() => runCommand(`talked to ${p.name}`)}>In touch</button>
              </li>
            ))}
          </ul>
        </div>
      );
    case "checklist":
      return <Checklist title={card.title} items={card.items} />;
    case "decision":
      return (
        <div className="acard decision">
          <div className="q">{card.question}</div>
          {card.options.map((o, i) => (
            <button key={i} onClick={() => runCommand(o.command ?? o.label)}>
              {o.label}
              {o.rationale && <small>{o.rationale}</small>}
            </button>
          ))}
        </div>
      );
    case "metrics":
      return (
        <div className="acard">
          {card.title && <div className="ct">{card.title}</div>}
          <div className="metrics">
            {card.items.map((m, i) => (
              <div className="metric" key={i} title={m.hint}>
                <div className="v">{m.value}</div>
                <div className="l">{m.label}</div>
              </div>
            ))}
          </div>
        </div>
      );
    case "confirm":
      return (
        <div className="acard row between">
          <span>{card.summary}</span>
          <button className="btn sm primary" onClick={() => runCommand(card.command)}>Confirm</button>
        </div>
      );
    case "risk":
      return <RiskCard report={card.report} compact />;
    case "council":
      return <CouncilCard verdict={card.verdict} />;
    case "calibration":
      return <CalibrationCard calibration={card.calibration} />;
    case "goals":
      return <GoalsCard goals={card.goals} alignment={card.alignment} />;
    case "ledger":
      return <LedgerCard entries={card.entries} />;
    case "payroll":
      return <PayrollCard payroll={card.payroll} compact />;
    case "focus":
      return (
        <div className="acard focus-card">
          <div className="t">{card.minutes}:00</div>
          <div>
            <div style={{ fontWeight: 500 }}>{card.title}</div>
            <button className="btn sm accent" style={{ marginTop: 6 }} onClick={() => setState({ focus: { title: card.title, minutes: card.minutes, startedAt: Date.now(), taskId: card.taskId } })}>
              <I.play /> Start
            </button>
          </div>
        </div>
      );
  }
}

function Checklist({ title, items: init }: { title: string; items: { text: string; done: boolean }[] }) {
  const [items, setItems] = useState(init);
  return (
    <div className="acard">
      <div className="ct">{title}</div>
      <ul>
        {items.map((it, i) => (
          <li key={i}>
            <button className="check" role="checkbox" aria-checked={it.done} onClick={() => setItems(items.map((x, j) => (j === i ? { ...x, done: !x.done } : x)))}>
              {it.done && <I.check />}
            </button>
            <span style={it.done ? { textDecoration: "line-through", color: "var(--ink-3)" } : undefined}>{it.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
