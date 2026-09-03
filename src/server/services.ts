/**
 * Services — the operations that both brains (Claude and Local Mind), the
 * scheduler and the HTTP routes share. One implementation, many callers.
 */
import type { Repo } from "./repo.js";
import {
  composeBrief,
  planDay,
  profileSummary,
  staleness,
  dayKey,
  parseDayKey,
  startOfDay,
  addDays,
  formatTime,
  type Brief,
  type Plan,
  type Preferences,
  type Task,
  type Event,
  type Person,
} from "../core/index.js";

export class Services {
  constructor(public readonly repo: Repo) {}

  prefs(): Preferences {
    return this.repo.getPrefs();
  }

  /** Plan a day and persist it. `date` may be a YYYY-MM-DD key or any instant on that day. */
  plan(dateInput: string | Date, now = new Date()): Plan {
    const prefs = this.prefs();
    const tz = prefs.timezone;
    const date = typeof dateInput === "string" ? (parseDayKey(dateInput, tz) ?? new Date(dateInput)) : dateInput;
    const day0 = startOfDay(date, tz);
    const day1 = addDays(day0, 1, tz);
    const plan = planDay({
      date: day0,
      now,
      tz,
      tasks: this.repo.listTasks({ status: "open" }),
      events: this.repo.listEvents({ from: day0.toISOString(), to: day1.toISOString() }),
      prefs,
    });
    this.repo.savePlan(plan);
    // reflect soft placements on tasks so lists can show "planned 10:30"
    const placed = new Map<string, { start: string; end: string }>();
    for (const b of plan.blocks) if (b.kind === "task" && b.taskId && !placed.has(b.taskId)) placed.set(b.taskId, { start: b.start, end: b.end });
    for (const t of this.repo.listTasks({ status: "open" })) {
      const p = placed.get(t.id);
      const wasToday = t.plannedStart && dayKey(new Date(t.plannedStart), tz) === plan.date;
      if (p && (t.plannedStart !== p.start || t.plannedEnd !== p.end)) this.repo.updateTask(t.id, { plannedStart: p.start, plannedEnd: p.end });
      else if (!p && wasToday) this.repo.updateTask(t.id, { plannedStart: undefined, plannedEnd: undefined });
    }
    return plan;
  }

  planFor(dateKey: string, now = new Date()): Plan {
    return this.repo.getPlan(dateKey) ?? this.plan(dateKey, now);
  }

  brief(kind: Brief["kind"], now = new Date()): Brief {
    const prefs = this.prefs();
    const tz = prefs.timezone;
    const today = dayKey(now, tz);
    const plan = kind === "weekly" ? undefined : this.planFor(today, now);
    const day0 = startOfDay(now, tz);
    return composeBrief({
      kind,
      now,
      tz,
      prefs,
      tasks: this.repo.listTasks({ status: "all" }),
      events: this.repo.listEvents({ from: addDays(day0, kind === "weekly" ? -8 : 0, tz).toISOString(), to: addDays(day0, 2, tz).toISOString() }),
      people: this.repo.listPeople(),
      memories: this.repo.listMemories(),
      plan,
    });
  }

  stalePeople(now = new Date(), minRatio = 1): { person: Person; overdueDays: number; ratio: number }[] {
    return this.repo
      .listPeople()
      .map((p) => ({ person: p, ...staleness(p, now) }))
      .filter((x) => x.ratio >= minRatio)
      .sort((a, b) => b.ratio - a.ratio);
  }

  overdueTasks(now = new Date()): Task[] {
    return this.repo.listTasks({ status: "open" }).filter((t) => t.due && new Date(t.due) < now);
  }

  todaysEvents(now = new Date()): Event[] {
    const tz = this.prefs().timezone;
    const day0 = startOfDay(now, tz);
    return this.repo.listEvents({ from: day0.toISOString(), to: addDays(day0, 1, tz).toISOString() });
  }

  /** A compact, model-readable snapshot of the person's world right now. */
  contextSnapshot(now = new Date()): string {
    const prefs = this.prefs();
    const tz = prefs.timezone;
    const open = this.repo.listTasks({ status: "open" });
    const overdue = this.overdueTasks(now);
    const events = this.todaysEvents(now);
    const stale = this.stalePeople(now);
    const lines = [
      `Now: ${now.toISOString()} (${new Intl.DateTimeFormat("en-US", { timeZone: tz, dateStyle: "full", timeStyle: "short" }).format(now)}, ${tz})`,
      `Person: ${prefs.name || "(name not set)"}; workday ${fmtMin(prefs.workdayStartMin)}–${fmtMin(prefs.workdayEndMin)}; autonomy=${prefs.autonomy}`,
      `Open tasks: ${open.length} (${overdue.length} overdue). Today's events: ${events.length}.`,
    ];
    if (events.length) lines.push("Today: " + events.map((e) => `${e.allDay ? "all-day" : formatTime(new Date(e.start), tz)} ${e.title}`).join("; "));
    if (overdue.length) lines.push("Overdue: " + overdue.slice(0, 6).map((t) => `${t.title} [${t.id}]`).join("; "));
    const top = open.filter((t) => !overdue.includes(t)).slice(0, 8);
    if (top.length) lines.push("Next open tasks: " + top.map((t) => `${t.title} [${t.id}]${t.due ? ` due ${t.due.slice(0, 10)}` : ""}`).join("; "));
    if (stale.length) lines.push("People drifting: " + stale.slice(0, 4).map((s) => `${s.person.name} (${Math.round(s.ratio * 100)}% of cadence)`).join("; "));
    const profile = profileSummary(this.repo.listMemories(), now, 5);
    if (profile) lines.push("What I know about them:\n" + profile);
    return lines.join("\n");
  }
}

function fmtMin(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
