/**
 * Scheduler — rituals and watchers. The part of Kairos that works while
 * you're not looking.
 */
import type { Services } from "./services.js";
import type { Bus } from "./bus.js";
import { nextOccurrence, dayKey, type Nudge, type Ritual, type Watcher } from "../core/index.js";

export class Scheduler {
  private timer?: NodeJS.Timeout;
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
  tick(): { rituals: string[]; watchers: string[] } {
    const now = this.now();
    const fired = { rituals: [] as string[], watchers: [] as string[] };
    const tz = this.svc.prefs().timezone;
    for (const r of this.svc.repo.listRituals()) {
      if (!r.enabled) continue;
      const anchor = r.lastRunAt ? new Date(r.lastRunAt) : new Date(now.getTime() - 6 * 3600_000);
      const due = nextOccurrence(r.rule, anchor, tz);
      if (due && due <= now) {
        this.runRitual(r, now);
        fired.rituals.push(r.id);
      }
    }
    for (const w of this.svc.repo.listWatchers()) {
      if (!w.enabled) continue;
      if (w.lastFiredAt && now.getTime() - new Date(w.lastFiredAt).getTime() < w.cooldownMin * 60_000) continue;
      const nudge = this.evaluateWatcher(w, now);
      if (nudge) {
        const n = this.svc.repo.createNudge(nudge);
        this.svc.repo.upsertWatcher({ ...w, lastFiredAt: now.toISOString() });
        this.bus.publish({ type: "nudge", nudgeId: n.id });
        fired.watchers.push(w.id);
      }
    }
    return fired;
  }

  runRitual(r: Ritual, now = this.now()): Nudge {
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
        const minute = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(now)) * 60;
        const weekday = new Date(new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(now)).getDay();
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
      case "empty_estimate":
        return undefined;
    }
  }
}
