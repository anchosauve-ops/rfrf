/**
 * Futures — a seeded Monte Carlo over the coming days.
 *
 * Each run draws a duration for every open task from a log-normal centered on
 * the calibrated estimate, draws daily interruption loss, then pours tasks in
 * priority-then-deadline order into the free capacity of each day (workday
 * minus meetings minus slack). Across runs we get, per deadline, the
 * probability of missing it, and we score interventions by how much risk
 * they remove. Deterministic for a given seed.
 */
import type { Calibration, Event, Intervention, Plan, Preferences, RiskReport, Task, TaskRisk } from "./types.js";
import { addDays, dayKey, startOfDay, toZoned, minutesBetween } from "./tz.js";
import { calibratedEstimate } from "./learning.js";

export interface SimInput {
  now: Date;
  tz: string;
  prefs: Preferences;
  tasks: Task[]; // open
  events: Event[]; // overlapping horizon
  calibration?: Calibration;
  horizonDays?: number;
  runs?: number;
  seed?: number;
  todayPlan?: Plan;
}

/** mulberry32 — small, fast, seedable */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r: () => number): number {
  const u = Math.max(1e-9, r());
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

interface DayCap {
  key: string;
  start: Date;
  end: Date;
  freeMin: number;
  meetingsMin: number;
}

export function dayCapacities(input: SimInput, horizonDays: number): DayCap[] {
  const { now, tz, prefs } = input;
  const out: DayCap[] = [];
  const day0 = startOfDay(now, tz);
  for (let i = 0; i < horizonDays; i++) {
    const ds = addDays(day0, i, tz);
    const de = addDays(day0, i + 1, tz);
    const weekday = toZoned(ds, tz).weekday;
    const isWork = prefs.workDays.includes(weekday);
    let start = new Date(ds.getTime() + prefs.workdayStartMin * 60000);
    const end = new Date(ds.getTime() + prefs.workdayEndMin * 60000);
    if (i === 0 && now > start) start = now;
    let windowMin = isWork ? Math.max(0, minutesBetween(start, end)) : 0;
    let meetingsMin = 0;
    for (const e of input.events) {
      if (e.allDay) continue;
      const s = new Date(e.start);
      const en = new Date(e.end);
      if (en <= ds || s >= de) continue;
      const overlapStart = Math.max(s.getTime(), start.getTime());
      const overlapEnd = Math.min(en.getTime(), end.getTime());
      const m = Math.max(0, Math.round((overlapEnd - overlapStart) / 60000));
      meetingsMin += m;
      windowMin -= m + (m ? prefs.meetingBufferMin * 2 : 0);
    }
    const freeMin = Math.max(0, Math.floor(windowMin * 0.85)); // same slack as the planner
    out.push({ key: dayKey(ds, tz), start, end, freeMin, meetingsMin });
  }
  return out;
}

interface SimTask {
  id: string;
  title: string;
  base: number; // calibrated minutes
  due?: number; // ms
  priority: number;
  goalId?: string;
  pinnedDay?: string;
}

function simulateOnce(tasks: SimTask[], caps: DayCap[], r: () => number, opts: { sigma: number; interruption: number }): Map<string, number> {
  // returns task id → completion ms (Infinity if not within horizon)
  const done = new Map<string, number>();
  const remaining = new Map<string, number>();
  for (const t of tasks) remaining.set(t.id, Math.max(10, t.base * Math.exp(opts.sigma * gauss(r))));
  const order = [...tasks].sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity) || a.priority - b.priority);
  for (const cap of caps) {
    let free = cap.freeMin * (1 - Math.min(0.6, Math.max(0, opts.interruption + 0.1 * gauss(r))));
    let cursor = cap.start.getTime();
    for (const t of order) {
      if (done.has(t.id) || free <= 0) continue;
      if (t.pinnedDay && t.pinnedDay !== cap.key) continue;
      const need = remaining.get(t.id)!;
      const take = Math.min(need, free);
      free -= take;
      cursor += take * 60000;
      if (take >= need - 1e-6) done.set(t.id, cursor);
      else remaining.set(t.id, need - take);
    }
  }
  for (const t of tasks) if (!done.has(t.id)) done.set(t.id, Infinity);
  return done;
}

export function simulateFutures(input: SimInput): RiskReport {
  const horizonDays = input.horizonDays ?? 7;
  const runs = input.runs ?? 200;
  const seed = input.seed ?? 42;
  const tz = input.tz;
  const caps = dayCapacities(input, horizonDays);
  const horizonEnd = caps[caps.length - 1]?.end.getTime() ?? input.now.getTime();

  const simTasks: SimTask[] = input.tasks
    .filter((t) => t.status === "open")
    .map((t) => ({
      id: t.id,
      title: t.title,
      base: calibratedEstimate(t, input.calibration),
      due: t.due ? new Date(t.due).getTime() : undefined,
      priority: t.priority,
      goalId: t.goalId,
      pinnedDay: t.pinnedStart ? dayKey(new Date(t.pinnedStart), tz) : undefined,
    }))
    // someday tasks with no date don't compete for capacity in the simulation
    .filter((t) => !(t.priority === 4 && !t.due));

  const sigma = 0.35;
  const interruption = input.calibration && input.calibration.planAdherence.n >= 5 ? Math.min(0.4, 0.1 + (1 - input.calibration.planAdherence.rate) * 0.3) : 0.15;

  const run = (tasks: SimTask[], s: number) => {
    const misses = new Map<string, number>();
    const completions = new Map<string, number[]>();
    const r = rng(s);
    for (let i = 0; i < runs; i++) {
      const res = simulateOnce(tasks, caps, r, { sigma, interruption });
      for (const t of tasks) {
        const c = res.get(t.id)!;
        if (t.due !== undefined && (c === Infinity ? t.due <= horizonEnd : c > t.due)) misses.set(t.id, (misses.get(t.id) ?? 0) + 1);
        (completions.get(t.id) ?? completions.set(t.id, []).get(t.id)!).push(c);
      }
    }
    return { misses, completions };
  };

  const base = run(simTasks, seed);
  const risks: TaskRisk[] = simTasks
    .filter((t) => t.due !== undefined)
    .map((t) => {
      const pMiss = (base.misses.get(t.id) ?? 0) / runs;
      const cs = [...(base.completions.get(t.id) ?? [])].sort((a, b) => a - b);
      const med = cs[Math.floor(cs.length / 2)] ?? Infinity;
      const expectedAt = med === Infinity ? new Date(horizonEnd) : new Date(med);
      return {
        taskId: t.id,
        title: t.title,
        due: new Date(t.due!).toISOString(),
        priority: t.priority as TaskRisk["priority"],
        pMiss: Math.round(pMiss * 100) / 100,
        expectedDay: med === Infinity ? "beyond horizon" : dayKey(expectedAt, tz),
        expectedAt: expectedAt.toISOString(),
        level: (pMiss >= 0.5 ? "danger" : pMiss >= 0.2 ? "watch" : "safe") as TaskRisk["level"],
        goalId: t.goalId,
      };
    })
    .sort((a, b) => b.pMiss * (5 - b.priority) - a.pMiss * (5 - a.priority));

  const totalRisk = (m: Map<string, number>, tasks: SimTask[]) => tasks.filter((t) => t.due !== undefined).reduce((n, t) => n + ((m.get(t.id) ?? 0) / runs) * (5 - t.priority), 0);
  const baseRisk = totalRisk(base.misses, simTasks);
  /** interventions report the share of total baseline risk they remove (0..1) */
  const share = (delta: number) => (baseRisk > 0 ? Math.round((delta / baseRisk) * 100) / 100 : 0);

  // ---- interventions: try each, measure risk delta ----
  const interventions: Intervention[] = [];
  const atRisk = risks.filter((r) => r.level !== "safe");
  if (atRisk.length) {
    const candidates = simTasks.filter((t) => t.priority >= 3 && t.due === undefined || (t.due !== undefined && t.due > horizonEnd));
    for (const c of candidates.slice(0, 12)) {
      const without = simTasks.filter((t) => t.id !== c.id);
      const r = run(without, seed + 1);
      const delta = baseRisk - totalRisk(r.misses, without);
      if (delta > 0.05) interventions.push({ id: `defer_${c.id}`, kind: "defer", title: `Push “${c.title}” past this week`, detail: `Frees ~${Math.round(c.base)} min of capacity.`, riskDelta: share(delta), command: `move ${c.title} to next week`, targetTaskId: c.id });
    }
    for (const rk of atRisk.slice(0, 4)) {
      const t = simTasks.find((x) => x.id === rk.taskId)!;
      if (t.base < 45 || (t.due !== undefined && t.due < input.now.getTime())) continue; // tiny or already-overdue: scoping down isn't the lever
      const shrunk = simTasks.map((x) => (x.id === t.id ? { ...x, base: Math.round(x.base * 0.6) } : x));
      const r = run(shrunk, seed + 2);
      const delta = baseRisk - totalRisk(r.misses, shrunk);
      if (delta > 0.05) interventions.push({ id: `shrink_${t.id}`, kind: "shrink", title: `Ship a smaller “${t.title}”`, detail: `If it could be done in ${Math.round(t.base * 0.6)} min instead of ${Math.round(t.base)}.`, riskDelta: share(delta), command: `update ${t.title} estimate to ${Math.round(t.base * 0.6)} minutes`, targetTaskId: t.id });
    }
    // meetings on the riskiest day
    const worstDay = caps.filter((c) => c.meetingsMin > 60).sort((a, b) => b.meetingsMin - a.meetingsMin)[0];
    if (worstDay) {
      const freed = caps.map((c) => (c.key === worstDay.key ? { ...c, freeMin: c.freeMin + 60 } : c));
      const r = (() => { const m = new Map<string, number>(); const rr = rng(seed + 3); for (let i = 0; i < runs; i++) { const res = simulateOnce(simTasks, freed, rr, { sigma, interruption }); for (const t of simTasks) { const c = res.get(t.id)!; if (t.due !== undefined && (c === Infinity ? t.due <= horizonEnd : c > t.due)) m.set(t.id, (m.get(t.id) ?? 0) + 1); } } return m; })();
      const delta = baseRisk - totalRisk(r, simTasks);
      if (delta > 0.05) interventions.push({ id: `meet_${worstDay.key}`, kind: "move_meeting", title: `Win back an hour of meetings on ${worstDay.key}`, detail: `${Math.round(worstDay.meetingsMin / 60 * 10) / 10}h of meetings that day.`, riskDelta: share(delta), command: `what's on ${worstDay.key}` });
    }
    interventions.sort((a, b) => b.riskDelta - a.riskDelta);
  }

  const availableMin = caps.reduce((n, c) => n + c.freeMin, 0);
  const demandedMin = simTasks.filter((t) => t.due === undefined || t.due <= horizonEnd).reduce((n, t) => n + t.base, 0);
  const loadByDay = caps.map((c) => {
    // expected demand landing on this day ≈ share of due tasks by day + spillover; approximate with base sim medians
    let load = 0;
    for (const t of simTasks) {
      const cs = base.completions.get(t.id) ?? [];
      const onDay = cs.filter((x) => x !== Infinity && dayKey(new Date(x), tz) === c.key).length / Math.max(1, cs.length);
      load += onDay * t.base;
    }
    return { day: c.key, load: c.freeMin ? Math.round((load / c.freeMin) * 100) / 100 : load > 0 ? 1.5 : 0, meetingsMin: c.meetingsMin };
  });

  return {
    horizonDays,
    runs,
    risks,
    interventions: interventions.slice(0, 6),
    capacity: { availableMin, demandedMin: Math.round(demandedMin), ratio: availableMin ? Math.round((demandedMin / availableMin) * 100) / 100 : 0 },
    loadByDay,
    generatedAt: input.now.toISOString(),
    seed,
  };
}
