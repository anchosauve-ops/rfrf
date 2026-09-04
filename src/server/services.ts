/**
 * Services — the operations that both brains (Claude and Local Mind), the
 * scheduler and the HTTP routes share. One implementation, many callers.
 */
import type { Repo } from "./repo.js";
import {
  composeBrief,
  planDay,
  fitCalibration,
  describeCalibration,
  simulateFutures,
  localCouncil,
  outcomeFromTask,
  alignment,
  findDuplicate,
  toZoned,
  type Calibration,
  type CouncilVerdict,
  type LedgerEntry,
  type RiskReport,
  type Payroll,
  computePayroll,
  payrollRange,
  parseWorklogText,
  fmtHM,
  formatMoney,
  weekStart,
  addDaysKey,
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
      calibration: this.calibration(now),
      goalIds: this.repo.listGoals().map((g) => g.id),
    });
    this.repo.savePlan(plan);
    // reflect soft placements on tasks so lists can show "planned 10:30" — only for today's plan,
    // so planning a future day never clobbers where things sit today
    if (plan.date !== dayKey(now, tz)) return plan;
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
      worklogs: this.repo.listWorklogs(),
    });
  }

  // ---------- team & payroll ----------
  payroll(person: Person, period: string | undefined, now = new Date()): Payroll & { label: string } {
    const tz = this.prefs().timezone;
    const r = payrollRange(period, now, tz);
    const pr = computePayroll({ personId: person.id, name: person.name, logs: this.repo.listWorklogs(person.id), rate: person.hourlyRate ?? 0, currency: person.currency, from: r.from, to: r.to, expectedWeeklyHours: person.expectedWeeklyHours, now });
    return { ...pr, label: r.label };
  }

  /** Import day totals for a person. Returns what changed, so the reply can be honest about it. */
  importWorklog(person: Person, days: { date: string; minutes: number }[], source: "timeproof" | "paste" | "manual" | "import", now = new Date()): { added: number; updated: number; unchanged: number; days: number; minutes: number } {
    let added = 0, updated = 0, unchanged = 0;
    const before = new Set(this.repo.listWorklogs(person.id).map((l) => l.date));
    for (const d of days) {
      const r = this.repo.upsertWorklog({ personId: person.id, date: d.date, minutes: d.minutes, source });
      if (!r.changed) unchanged++;
      else if (before.has(d.date)) updated++;
      else added++;
    }
    void now;
    return { added, updated, unchanged, days: days.length, minutes: days.reduce((n, d) => n + d.minutes, 0) };
  }

  importWorklogText(person: Person, text: string, source: "timeproof" | "paste" | "manual" | "import", now = new Date()) {
    const parsed = parseWorklogText(text, { now, tz: this.prefs().timezone });
    const result = this.importWorklog(person, parsed.days, source, now);
    return { ...result, parsedDays: parsed.days, dropped: parsed.dropped };
  }

  /** One row per paid worker: this week, this month, all time. */
  teamSummary(now = new Date()) {
    const tz = this.prefs().timezone;
    const today = dayKey(now, tz);
    const ws = weekStart(today);
    return this.repo
      .listPeople()
      .filter((p) => p.hourlyRate)
      .map((p) => {
        const logs = this.repo.listWorklogs(p.id);
        const week = computePayroll({ personId: p.id, name: p.name, logs, rate: p.hourlyRate!, currency: p.currency, from: ws, to: addDaysKey(ws, 6), now });
        const mr = payrollRange("this month", now, tz);
        const month = computePayroll({ personId: p.id, name: p.name, logs, rate: p.hourlyRate!, currency: p.currency, from: mr.from, to: mr.to, now });
        const all = computePayroll({ personId: p.id, name: p.name, logs, rate: p.hourlyRate!, currency: p.currency, from: "0000-01-01", to: "9999-12-31", now });
        const last = logs.length ? logs[logs.length - 1]! : undefined;
        return { person: p, week, month, all, lastLog: last?.date, lastImportAt: logs.reduce<string | undefined>((m, l) => (!m || l.importedAt > m ? l.importedAt : m), undefined), summary: `${p.name}: ${fmtHM(week.totalMinutes)} this week (${formatMoney(week.amount, week.currency)}), ${fmtHM(month.totalMinutes)} this month (${formatMoney(month.amount, month.currency)})` };
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

  // ---------- learning ----------
  private calCache?: { at: number; cal: Calibration; n: number };
  calibration(now = new Date()): Calibration {
    const outcomes = this.repo.listOutcomes();
    if (this.calCache && this.calCache.n === outcomes.length && now.getTime() - this.calCache.at < 60_000) return this.calCache.cal;
    const cal = fitCalibration(outcomes, this.prefs(), now);
    this.calCache = { at: now.getTime(), cal, n: outcomes.length };
    return cal;
  }

  /** Record what actually happened when a task completes. Called by complete_task. */
  recordOutcome(task: Task, now = new Date(), actualMin?: number): void {
    const tz = this.prefs().timezone;
    const z = toZoned(now, tz);
    const focus = this.repo.focusMinutesForTask(task.id);
    const plannedDay = task.plannedStart ? dayKey(new Date(task.plannedStart), tz) : undefined;
    this.repo.addOutcome(
      outcomeFromTask(task, {
        completedAt: now,
        hour: z.hour,
        weekday: z.weekday,
        actualMin: actualMin ?? (focus > 0 ? focus : undefined),
        plannedDay,
        completedDay: dayKey(now, tz),
      }),
    );
    this.calCache = undefined;
    // auto-tune the energy curve when allowed and the evidence is strong
    const prefs = this.prefs();
    if (prefs.autoTuneCurve) {
      const cal = this.calibration(now);
      if (cal.proposedCurve && JSON.stringify(cal.proposedCurve) !== JSON.stringify(prefs.energyCurve)) {
        const before = prefs.energyCurve;
        this.repo.setPrefs({ energyCurve: cal.proposedCurve });
        this.repo.addLedger({ action: "tune_curve", summary: "Adopted the energy curve learned from your completions.", reason: `${cal.sampleSize} outcomes; peaks: deep ${cal.peakHours.deep.slice(0, 2).join(",")}h`, undo: [{ entity: "prefs", patch: { energyCurve: before } }], origin: "learning" });
      }
    }
  }

  // ---------- futures ----------
  futures(now = new Date(), horizonDays = 7): RiskReport {
    const prefs = this.prefs();
    const tz = prefs.timezone;
    const day0 = startOfDay(now, tz);
    return simulateFutures({
      now,
      tz,
      prefs,
      tasks: this.repo.listTasks({ status: "open" }),
      events: this.repo.listEvents({ from: day0.toISOString(), to: addDays(day0, horizonDays, tz).toISOString() }),
      calibration: prefs.useCalibration ? this.calibration(now) : undefined,
      horizonDays,
      runs: 200,
      seed: Number(dayKey(now, tz).replace(/-/g, "")) % 100000,
    });
  }

  // ---------- council ----------
  councilInput(now = new Date(), question?: string) {
    const prefs = this.prefs();
    const tz = prefs.timezone;
    const day0 = startOfDay(now, tz);
    return {
      question,
      now,
      tz,
      prefs,
      tasks: this.repo.listTasks({ status: "all" }),
      events: this.repo.listEvents({ from: day0.toISOString(), to: addDays(day0, 7, tz).toISOString() }),
      people: this.repo.listPeople(),
      memories: this.repo.listMemories(),
      goals: this.repo.listGoals(),
      plan: this.planFor(dayKey(now, tz), now),
      risk: this.futures(now),
      calibration: this.calibration(now),
    };
  }
  localCouncil(now = new Date(), question?: string): CouncilVerdict {
    return localCouncil(this.councilInput(now, question));
  }

  goalAlignment(now = new Date()) {
    const tz = this.prefs().timezone;
    const weekAgo = new Date(now.getTime() - 7 * 86400_000).toISOString();
    return alignment(this.repo.listGoals(), this.repo.listTasks({ status: "all" }), { plan: this.repo.getPlan(dayKey(now, tz)), outcomes: this.repo.listOutcomes(weekAgo) });
  }

  // ---------- guardian & ledger ----------
  /** Apply an intervention autonomously, recording how to undo it. */
  intervene(kind: "defer" | "shrink", taskId: string, reason: string, origin: string, now = new Date()): LedgerEntry | undefined {
    const t = this.repo.getTask(taskId);
    if (!t) return undefined;
    const tz = this.prefs().timezone;
    if (kind === "defer") {
      const nextMonday = (() => { const z = toZoned(now, tz); const delta = ((8 - z.weekday) % 7) || 7; return addDays(startOfDay(now, tz), delta, tz); })();
      // null (not undefined) survives JSON so undo can clear fields it needs to clear
      const before = { due: t.due ?? null, pinnedStart: t.pinnedStart ?? null, snoozedUntil: t.snoozedUntil ?? null };
      this.repo.updateTask(t.id, { snoozedUntil: nextMonday.toISOString(), pinnedStart: undefined, due: t.due && new Date(t.due) < nextMonday ? nextMonday.toISOString() : t.due });
      return this.repo.addLedger({ action: "defer_task", summary: `Pushed “${t.title}” to next week.`, reason, undo: [{ entity: "task", id: t.id, patch: before }], origin });
    }
    const before = { estimateMin: t.estimateMin };
    const next = Math.max(15, Math.round((t.estimateMin * 0.6) / 5) * 5);
    this.repo.updateTask(t.id, { estimateMin: next });
    return this.repo.addLedger({ action: "shrink_estimate", summary: `Scoped “${t.title}” down to ${next} min.`, reason, undo: [{ entity: "task", id: t.id, patch: before }], origin });
  }

  undo(entryId?: string): LedgerEntry | undefined {
    const entry = entryId ? this.repo.getLedger(entryId) : this.repo.listLedger(50).find((e) => !e.undoneAt);
    if (!entry || entry.undoneAt) return undefined;
    for (const u of entry.undo) {
      // JSON null means "clear this field"
      const patch = Object.fromEntries(Object.entries(u.patch).map(([k, v]) => [k, v === null ? undefined : v]));
      if (u.entity === "task" && u.id) this.repo.updateTask(u.id, patch as never);
      else if (u.entity === "event" && u.id) this.repo.updateEvent(u.id, patch as never);
      else if (u.entity === "prefs") this.repo.setPrefs(patch as never);
    }
    this.repo.markUndone(entry.id);
    this.calCache = undefined;
    return { ...entry, undoneAt: new Date().toISOString() };
  }

  /** Nightly: turn calibration into insight memories (deduped), so the model and the Mirror share one truth. */
  reflect(now = new Date()): string[] {
    const cal = this.calibration(now);
    const lines = describeCalibration(cal);
    const existing = this.repo.listMemories();
    const added: string[] = [];
    for (const line of lines) {
      const dup = findDuplicate(existing, line, 0.6);
      if (dup) {
        this.repo.updateMemory(dup.id, { text: line, confidence: Math.min(1, dup.confidence + 0.05), evidence: `Recomputed from ${cal.sampleSize} outcomes on ${dayKey(now, this.prefs().timezone)}.` });
      } else {
        this.repo.createMemory({ text: line, kind: "insight", source: "inferred", confidence: Math.min(0.9, 0.5 + cal.sampleSize / 100), importance: 0.7, evidence: `Computed from ${cal.sampleSize} completed tasks.`, tags: ["learned"] });
        added.push(line);
      }
    }
    return added;
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
    const goals = this.repo.listGoals();
    if (goals.length) lines.push("Goals: " + goals.map((g) => `${g.title} [${g.id}] (${g.horizon}, ${Math.round(g.progress * 100)}%)`).join("; "));
    const team = this.teamSummary(now);
    if (team.length) lines.push("Team (paid workers): " + team.map((t) => `${t.summary} at ${formatMoney(t.person.hourlyRate!, t.person.currency ?? "USD")}/h [${t.person.id}]`).join("; "));
    const cal = this.calibration(now);
    const learned = describeCalibration(cal);
    if (learned.length) lines.push("Learned about them: " + learned.join(" "));
    const profile = profileSummary(this.repo.listMemories(), now, 5);
    if (profile) lines.push("What I know about them:\n" + profile);
    return lines.join("\n");
  }
}

// ============ Symbiosis ============
export interface SymbiosisServices {
  calibration(now?: Date): Calibration;
}

function fmtMin(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
