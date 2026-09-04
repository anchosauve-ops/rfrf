/**
 * Scheduler — rituals and watchers. The part of Kairos that works while
 * you're not looking.
 */
import type { Services } from "./services.js";
import type { Bus } from "./bus.js";
import { nextOccurrence, dayKey, toZoned, type Nudge, type Ritual, type Watcher } from "../core/index.js";

export class Scheduler {
  private timer?: NodeJS.Timeout;
  /** optional hooks run once per day (e.g. backups); errors are contained */
  daily: { name: string; run: () => void; lastRunDay?: string }[] = [];
  constructor(private svc: Services, private bus: Bus, private now: () => Date = () => new Date()) {}

  start(intervalMs = 60_000): void {
    this.stop();
    this.tick();
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass. Exposed for tests and for "run now" buttons. */
  tick(): { rituals: string[]; watchers: string[]; errors: string[] } {
    const now = this.now();
    const fired = { rituals: [] as string[], watchers: [] as string[], errors: [] as string[] };
    const tz = this.svc.prefs().timezone;
    for (const r of this.svc.repo.listRituals()) {
      if (!r.enabled) continue;
      try {
        const anchor = r.lastRunAt ? new Date(r.lastRunAt) : new Date(now.getTime() - 6 * 3600_000);
        const due = nextOccurrence(r.rule, anchor, tz);
        if (due && due <= now) {
          this.runRitual(r, now);
          fired.rituals.push(r.id);
        }
      } catch (e) {
        fired.errors.push(`ritual ${r.id}: ${e instanceof Error ? e.message : String(e)}`);
        // don't let a broken ritual fire every minute forever
        this.svc.repo.upsertRitual({ ...r, lastRunAt: now.toISOString() });
      }
    }
    for (const w of this.svc.repo.listWatchers()) {
      if (!w.enabled) continue;
      if (w.lastFiredAt && now.getTime() - new Date(w.lastFiredAt).getTime() < w.cooldownMin * 60_000) continue;
      try {
        const nudge = this.evaluateWatcher(w, now);
        if (nudge) {
          const n = this.svc.repo.createNudge(nudge);
          this.svc.repo.upsertWatcher({ ...w, lastFiredAt: now.toISOString() });
          this.bus.publish({ type: "nudge", nudgeId: n.id });
          fired.watchers.push(w.id);
        }
      } catch (e) {
        fired.errors.push(`watcher ${w.id}: ${e instanceof Error ? e.message : String(e)}`);
        this.svc.repo.upsertWatcher({ ...w, lastFiredAt: now.toISOString() });
      }
    }
    const day = dayKey(now, tz);
    for (const h of this.daily) {
      if (h.lastRunDay === day) continue;
      try {
        h.run();
      } catch (e) {
        fired.errors.push(`daily ${h.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
      h.lastRunDay = day;
    }
    if (fired.errors.length) console.error("[kairos] scheduler:", fired.errors.join("; "));
    return fired;
  }

  runRitual(r: Ritual, now = this.now()): Nudge {
    if (r.kind === "reflection") {
      const added = this.svc.reflect(now);
      const cal = this.svc.calibration(now);
      const nudge = this.svc.repo.createNudge({
        title: "Nightly reflection",
        body: added.length ? `Learned ${added.length} new thing${added.length === 1 ? "" : "s"} from ${cal.sampleSize} completed tasks.` : `Recomputed what I know from ${cal.sampleSize} completed tasks. Nothing new tonight.`,
        level: "info",
        cards: [{ type: "calibration", calibration: cal }],
        actions: [{ label: "Open the mirror", command: "mirror", style: "primary" }],
        origin: r.id,
      });
      this.svc.repo.upsertRitual({ ...r, lastRunAt: now.toISOString() });
      this.bus.publish({ type: "ritual", ritualId: r.id });
      this.bus.publish({ type: "nudge", nudgeId: nudge.id });
      return nudge;
    }
    const kind = r.kind === "morning_brief" ? "morning" : r.kind === "evening_review" ? "evening" : r.kind === "weekly_retro" ? "weekly" : "morning";
    if (kind === "morning") this.svc.plan(dayKey(now, this.svc.prefs().timezone), now);
    const brief = this.svc.brief(kind, now);
    const nudge = this.svc.repo.createNudge({
      title: r.name,
      body: `${brief.greeting} ${brief.headline}`,
      level: "info",
      cards: [{ type: "brief", brief }],
      actions:
        kind === "morning"
          ? [{ label: "Plan my day", command: "plan my day", style: "primary" }, { label: "What's overdue?", command: "what's overdue" }]
          : kind === "evening"
            ? [{ label: "Plan tomorrow", command: "plan tomorrow", style: "primary" }]
            : [{ label: "Show debt", command: "what's overdue" }],
      origin: r.id,
    });
    this.svc.repo.upsertRitual({ ...r, lastRunAt: now.toISOString() });
    this.bus.publish({ type: "ritual", ritualId: r.id });
    this.bus.publish({ type: "nudge", nudgeId: nudge.id });
    return nudge;
  }

  evaluateWatcher(w: Watcher, now: Date): Omit<Nudge, "id" | "createdAt"> | undefined {
    const repo = this.svc.repo;
    const tz = this.svc.prefs().timezone;
    switch (w.kind) {
      case "overdue_tasks": {
        const overdue = this.svc.overdueTasks(now).filter((t) => (now.getTime() - new Date(t.due!).getTime()) / 86400_000 >= w.threshold);
        if (!overdue.length) return undefined;
        return {
          title: overdue.length === 1 ? "One task has slipped" : `${overdue.length} tasks have slipped`,
          body: overdue.slice(0, 3).map((t) => t.title).join(", ") + (overdue.length > 3 ? "…" : "") + ". Reschedule, do, or drop?",
          level: "suggest",
          cards: [{ type: "tasks", title: "Overdue", tasks: overdue.slice(0, 6) }],
          actions: [{ label: "Replan today", command: "plan my day", style: "primary" }, { label: "Show all overdue", command: "what's overdue" }],
          origin: w.id,
        };
      }
      case "stale_people": {
        const stale = this.svc.stalePeople(now, w.threshold);
        if (!stale.length) return undefined;
        const p = stale[0]!.person;
        return {
          title: `It's been a while since ${p.name}`,
          body: `${Math.round(stale[0]!.ratio * 100)}% of your usual cadence. ${stale.length > 1 ? `${stale.length - 1} other${stale.length > 2 ? "s" : ""} drifting too.` : ""}`.trim(),
          level: "suggest",
          cards: [{ type: "people", title: "Drifting", people: stale.slice(0, 4).map((s) => s.person) }],
          actions: [{ label: `Add "reach out to ${p.name}"`, command: `reach out to ${p.name} tomorrow`, style: "primary" }, { label: `Talked to ${p.name}`, command: `talked to ${p.name}` }],
          origin: w.id,
        };
      }
      case "overloaded_day": {
        const plan = repo.getPlan(dayKey(now, tz));
        if (!plan || plan.stats.loadPct < w.threshold) return undefined;
        return {
          title: `Today is at ${plan.stats.loadPct}% load`,
          body: `${plan.unscheduled.length} task${plan.unscheduled.length === 1 ? "" : "s"} already didn't fit. Something has to give: push a task, or shorten a meeting.`,
          level: "suggest",
          cards: [{ type: "plan", plan }],
          actions: [{ label: "Show what didn't fit", command: "what's on my list today" }],
          origin: w.id,
        };
      }
      case "deadline_approaching": {
        const horizon = new Date(now.getTime() + w.threshold * 3600_000);
        const soon = repo.listTasks({ status: "open" }).filter((t) => t.due && new Date(t.due) > now && new Date(t.due) <= horizon && t.priority <= 2 && !t.plannedStart);
        if (!soon.length) return undefined;
        return {
          title: `${soon[0]!.title} is due soon and unplanned`,
          body: `Due ${new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(soon[0]!.due!))}. Want it on today's plan?`,
          level: "act",
          cards: [{ type: "tasks", title: "Due soon", tasks: soon.slice(0, 4) }],
          actions: [{ label: "Plan it in", command: "plan my day", style: "primary" }],
          origin: w.id,
        };
      }
      case "unplanned_day": {
        const prefs = this.svc.prefs();
        const z = toZoned(now, tz);
        const minute = z.hour * 60 + z.minute;
        const weekday = z.weekday;
        if (!prefs.workDays.includes(weekday) || minute < prefs.workdayStartMin || minute > prefs.workdayStartMin + 90) return undefined;
        if (repo.getPlan(dayKey(now, tz))) return undefined;
        if (!repo.listTasks({ status: "open" }).length) return undefined;
        return {
          title: "No plan for today yet",
          body: "You've got open tasks and an open day. Want me to lay it out?",
          level: "suggest",
          actions: [{ label: "Plan my day", command: "plan my day", style: "primary" }],
          origin: w.id,
        };
      }
      case "deadline_risk": {
        const prefs = this.svc.prefs();
        const report = this.svc.futures(now);
        const danger = report.risks.filter((r) => r.pMiss >= w.threshold && r.priority <= 2);
        if (!danger.length) return undefined;
        const top = danger[0]!;
        const best = report.interventions[0];
        // Guardian only ever defers (a reversible scheduling change). Scoping work down is the person's call.
        const autoMove = report.interventions.find((i) => i.kind === "defer" && i.targetTaskId);
        if (prefs.autonomy === "guardian" && autoMove && autoMove.targetTaskId) {
          const entry = this.svc.intervene("defer", autoMove.targetTaskId, `“${top.title}” had a ${Math.round(top.pMiss * 100)}% chance of missing its deadline.`, w.id, now);
          if (entry) {
            this.svc.plan(dayKey(now, tz), now);
            return {
              title: `Guardian acted: ${entry.summary}`,
              body: `${entry.reason} This removed about ${Math.round(autoMove.riskDelta * 100)}% of this week's deadline risk. Undo any time.`,
              level: "act",
              cards: [{ type: "ledger", entries: [entry] }, { type: "risk", report }],
              actions: [{ label: "Undo", command: "undo", style: "danger" }, { label: "See futures", command: "what's at risk" }],
              origin: w.id,
            };
          }
        }
        return {
          title: `“${top.title}” is at ${Math.round(top.pMiss * 100)}% risk of slipping`,
          body: `${report.runs} simulated weeks say it lands ${top.expectedDay}. ${best ? `Best move: ${best.title.toLowerCase()} (−${Math.round(best.riskDelta * 100)}% of risk).` : ""}`.trim(),
          level: "act",
          cards: [{ type: "risk", report }],
          actions: [...(best ? [{ label: best.title, command: best.command, style: "primary" as const }] : []), { label: "Convene the council", command: "convene the council" }],
          origin: w.id,
        };
      }
      case "team_hours": {
        // Thursday onward: a paid worker with an expectation who is below threshold × expected for the week
        const z = toZoned(now, tz);
        if (z.weekday < 4) return undefined;
        const light = this.svc.teamSummary(now).filter((r) => r.person.expectedWeeklyHours && r.week.totalMinutes < r.person.expectedWeeklyHours * 60 * w.threshold);
        if (!light.length) return undefined;
        const r = light[0]!;
        return {
          title: `${r.person.name} is at ${Math.round((r.week.totalMinutes / 60) * 10) / 10}h this week`,
          body: `Expected about ${r.person.expectedWeeklyHours}h. ${r.lastLog ? `Last logged day: ${r.lastLog}.` : "No hours logged yet."} Could be a light week, or Timeproof hasn't been imported.`,
          level: "suggest",
          cards: [{ type: "payroll", payroll: r.week }],
          actions: [{ label: `Import ${r.person.name}'s Timeproof`, command: `import timeproof for ${r.person.name}: `, style: "primary" }, { label: "Team", command: "team" }],
          origin: w.id,
        };
      }
      case "empty_estimate":
        return undefined;
    }
  }
}
