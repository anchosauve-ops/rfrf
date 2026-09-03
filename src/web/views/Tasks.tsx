import { useMemo, useState } from "react";
import type { Task } from "@core/types";
import { api, emitLocal } from "../lib/api";
import { runCommand, useNow, useResource, useStore, toast } from "../lib/store";
import { dueLabel, fmtTime, minutes, relDay } from "../lib/time";
import { I } from "../components/Icons";
import { EnergyDot } from "../components/Cards";

type Group = { key: string; title: string; tasks: Task[] };

export function TasksView() {
  const ctx = useStore((s) => s.ctx);
  const tz = ctx?.prefs.timezone;
  const now = useNow(30_000);
  const [showDone, setShowDone] = useState(false);
  const { data: open, reload } = useResource<Task[]>("/tasks?status=open", ["task", "plan"]);
  const { data: done } = useResource<Task[]>(showDone ? "/tasks?status=done" : null, ["task"], [showDone]);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<string>("");

  const groups = useMemo<Group[]>(() => {
    const t = now.getTime();
    const dayEnd = new Date(now); dayEnd.setHours(23, 59, 59, 999);
    const week = t + 7 * 86400_000;
    const g: Record<string, Task[]> = { overdue: [], today: [], week: [], later: [], someday: [] };
    for (const task of open ?? []) {
      const due = task.due ? new Date(task.due).getTime() : undefined;
      const pinned = task.pinnedStart ? new Date(task.pinnedStart).getTime() : undefined;
      if (due !== undefined && due < t) g.overdue!.push(task);
      else if ((due !== undefined && due <= dayEnd.getTime()) || (pinned !== undefined && pinned <= dayEnd.getTime()) || (task.plannedStart && new Date(task.plannedStart).toDateString() === now.toDateString())) g.today!.push(task);
      else if ((due !== undefined && due <= week) || (pinned !== undefined && pinned <= week)) g.week!.push(task);
      else if (task.priority === 4 && !due) g.someday!.push(task);
      else g.later!.push(task);
    }
    const order = (a: Task, b: Task) => (a.due ?? a.pinnedStart ?? "9").localeCompare(b.due ?? b.pinnedStart ?? "9") || a.priority - b.priority;
    return [
      { key: "overdue", title: "Overdue", tasks: g.overdue!.sort(order) },
      { key: "today", title: "Today", tasks: g.today!.sort(order) },
      { key: "week", title: "This week", tasks: g.week!.sort(order) },
      { key: "later", title: "Later", tasks: g.later!.sort((a, b) => a.priority - b.priority) },
      { key: "someday", title: "Someday", tasks: g.someday! },
    ].filter((x) => x.tasks.length);
  }, [open, now]);

  const onType = async (v: string) => {
    setText(v);
    if (v.trim().length < 4) return setPreview("");
    try {
      const r = await api.get<{ start?: string; remainder: string; recurrence?: unknown; isDeadline: boolean; allDay: boolean }>(`/parse?text=${encodeURIComponent(v)}`);
      setPreview(r.start ? `${r.isDeadline ? "due" : r.allDay ? "on" : "at"} ${relDay(r.start, now, tz)}${r.allDay ? "" : " " + fmtTime(r.start, tz)}${r.recurrence ? " · repeats" : ""}` : "");
    } catch {
      setPreview("");
    }
  };

  const total = open?.length ?? 0;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="display" style={{ fontSize: 36 }}>Tasks</h1>
          <p className="sub">{total} open{groups[0]?.key === "overdue" ? ` · ${groups[0].tasks.length} overdue` : ""}</p>
        </div>
        <button className="btn ghost sm" onClick={() => setShowDone(!showDone)}>{showDone ? "Hide done" : "Show done"}</button>
      </div>

      <form className="capture" onSubmit={(e) => { e.preventDefault(); if (text.trim()) { runCommand(text.trim()); setText(""); setPreview(""); } }}>
        <input value={text} onChange={(e) => void onType(e.target.value)} placeholder="Capture anything: “send the deck to Priya by thu 3pm (45m) !2”" aria-label="Capture a task" />
        {preview && <span className="hint">{preview}</span>}
        <button className="btn icon primary" type="submit" disabled={!text.trim()} aria-label="Add"><I.send /></button>
      </form>

      {groups.length === 0 && <div className="empty" style={{ marginTop: 20 }}><span className="serif">Clear.</span>Nothing open. Capture something above, or enjoy it.</div>}
      {groups.map((g) => (
        <div key={g.key}>
          <h2 className="section">{g.title} <span className="muted" style={{ fontWeight: 400, letterSpacing: 0 }}>{g.tasks.length}</span></h2>
          <div className="card" style={{ padding: "6px 8px" }}>
            {g.tasks.map((t) => <TaskRow key={t.id} t={t} now={now} tz={tz} reload={reload} />)}
          </div>
        </div>
      ))}
      {showDone && done && done.length > 0 && (
        <>
          <h2 className="section">Done</h2>
          <div className="card" style={{ padding: "6px 8px" }}>{done.slice(0, 40).map((t) => <TaskRow key={t.id} t={t} now={now} tz={tz} reload={reload} />)}</div>
        </>
      )}
    </div>
  );
}

function TaskRow({ t, now, tz, reload }: { t: Task; now: Date; tz?: string; reload: () => void }) {
  const [edit, setEdit] = useState(false);
  const [draft, setDraft] = useState<Partial<Task> & { dueText?: string }>({});
  const due = t.due ? dueLabel(t.due, now, tz) : undefined;

  const complete = async () => {
    if (t.status === "done") {
      await api.patch(`/tasks/${t.id}`, { status: "open" });
    } else {
      await api.post(`/tasks/${t.id}/complete`);
    }
    emitLocal({ type: "mutation", entity: "task" });
    reload();
  };
  const save = async () => {
    const patch: Record<string, unknown> = { ...draft };
    delete patch.dueText;
    if (draft.dueText !== undefined) {
      if (!draft.dueText.trim()) patch.due = null;
      else {
        const r = await api.get<{ start?: string }>(`/parse?text=${encodeURIComponent(draft.dueText)}`);
        if (!r.start) return toast("Couldn't read that time");
        patch.due = r.start;
      }
    }
    await api.patch(`/tasks/${t.id}`, patch);
    emitLocal({ type: "mutation", entity: "task" });
    setEdit(false);
    setDraft({});
    reload();
  };
  const remove = async () => {
    if (!confirm(`Delete "${t.title}"?`)) return;
    await api.del(`/tasks/${t.id}`);
    emitLocal({ type: "mutation", entity: "task" });
    reload();
  };

  return (
    <div className={`task ${t.status === "done" ? "done" : ""}`}>
      <button className="check" role="checkbox" aria-checked={t.status === "done"} onClick={() => void complete()} aria-label="Toggle done">{t.status === "done" && <I.check />}</button>
      <div style={{ minWidth: 0 }} onClick={() => !edit && setEdit(true)}>
        <div className="title">{t.title}</div>
        <div className="meta">
          <span className={`badge ${t.energy}`}><EnergyDot e={t.energy} />{t.energy}</span>
          {due && <span className={due.overdue ? "over" : ""}>{due.text}</span>}
          {t.pinnedStart && <span>at {relDay(t.pinnedStart, now, tz)} {fmtTime(t.pinnedStart, tz)}</span>}
          {t.plannedStart && !t.pinnedStart && t.status === "open" && <span className="badge accent">planned {fmtTime(t.plannedStart, tz)}</span>}
          <span>{minutes(t.estimateMin)}</span>
          {t.priority <= 2 && <span className={`badge ${t.priority === 1 ? "danger" : ""}`}>{t.priority === 1 ? "critical" : "important"}</span>}
          {t.recurrence && <span>↻</span>}
          {t.goalId && <span className="badge">◎ goal</span>}
          {t.tags.map((x) => <span key={x}>#{x}</span>)}
        </div>
        {edit && (
          <div className="task-edit" onClick={(e) => e.stopPropagation()}>
            <label className="field full"><span>Title</span><input className="input" defaultValue={t.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
            <label className="field"><span>Due (natural language)</span><input className="input" placeholder={t.due ? `${relDay(t.due, now, tz)} ${fmtTime(t.due, tz)}` : "e.g. friday 5pm"} onChange={(e) => setDraft({ ...draft, dueText: e.target.value })} /></label>
            <label className="field"><span>Estimate (min)</span><input className="input" type="number" defaultValue={t.estimateMin} onChange={(e) => setDraft({ ...draft, estimateMin: Number(e.target.value) })} /></label>
            <label className="field"><span>Priority</span>
              <select className="select" defaultValue={t.priority} onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) as Task["priority"] })}>
                <option value={1}>1 · critical</option><option value={2}>2 · important</option><option value={3}>3 · normal</option><option value={4}>4 · someday</option>
              </select>
            </label>
            <label className="field"><span>Energy</span>
              <select className="select" defaultValue={t.energy} onChange={(e) => setDraft({ ...draft, energy: e.target.value as Task["energy"] })}>
                <option value="deep">deep</option><option value="light">light</option><option value="admin">admin</option><option value="social">social</option>
              </select>
            </label>
            <label className="field full"><span>Notes</span><textarea className="textarea" defaultValue={t.notes ?? ""} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} /></label>
            <div className="row full" style={{ justifyContent: "space-between" }}>
              <button className="btn sm danger" onClick={() => void remove()}><I.trash /> Delete</button>
              <span className="row" style={{ gap: 6 }}>
                <button className="btn sm ghost" onClick={() => { setEdit(false); setDraft({}); }}>Cancel</button>
                <button className="btn sm primary" onClick={() => void save()}>Save</button>
              </span>
            </div>
          </div>
        )}
      </div>
      {!edit && t.status === "open" && (
        <div className="row" style={{ gap: 2 }}>
          <button className="btn icon ghost" title="Focus on this" onClick={() => runCommand(`focus for ${Math.min(90, t.estimateMin || 25)} on ${t.title}`)}><I.play /></button>
          <button className="btn icon ghost" title="Push to tomorrow" onClick={() => runCommand(`move ${t.title} to tomorrow`)}><I.right /></button>
        </div>
      )}
    </div>
  );
}
