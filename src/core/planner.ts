/**
 * Planner — turns an unordered pile of tasks and a calendar into a day.
 *
 * It's deterministic and explainable: every block carries a `reason`, so the
 * agent (and the person) can see *why* something landed where it did.
 *
 * Scoring blends urgency (deadline pressure), importance (priority), age,
 * and energy fit (your personal curve: deep work in the morning, admin in
 * the trough, social around lunch). Placement is greedy in time order with
 * automatic breaks, meeting buffers, task splitting, and a slack reserve so
 * the day isn't scheduled to 100%.
 */
import type { Calibration, Energy, Event, Plan, PlanBlock, Preferences, Task } from "./types.js";
import { calibratedEstimate } from "./learning.js";
import { addMinutes, dayKey, minuteOfDay, minutesBetween, setTime, startOfDay, toZoned, sameDay } from "./tz.js";
import { uid } from "./ids.js";

export interface PlannerInput {
  date: Date;
  now: Date;
  tz: string;
  tasks: Task[];
  events: Event[];
  prefs: Preferences;
  /** learned model; when present and prefs.useCalibration, estimates are scaled */
  calibration?: Calibration;
  /** ids of active goals; goal-linked tasks get a small priority bonus */
  goalIds?: string[];
}

interface Interval {
  start: Date;
  end: Date;
}

interface Candidate {
  task: Task;
  remainingMin: number;
  base: number;
  reasons: string[];
  parts: number;
}

const MIN_SLOT = 15;
const MIN_SPLIT = 30;
const SLACK = 0.85;

const ENERGY_NEIGHBORS: Record<Energy, Energy[]> = {
  deep: ["light"],
  light: ["deep", "admin"],
  admin: ["light", "social"],
  social: ["admin", "light"],
};

export function energyAt(prefs: Preferences, minute: number): Energy | undefined {
  return prefs.energyCurve.find((s) => minute >= s.fromMin && minute < s.toMin)?.best;
}

function roundUp(d: Date, step: number): Date {
  const ms = step * 60000;
  return new Date(Math.ceil(d.getTime() / ms) * ms);
}

function subtract(free: Interval[], busy: Interval): Interval[] {
  const out: Interval[] = [];
  for (const f of free) {
    if (busy.end <= f.start || busy.start >= f.end) {
      out.push(f);
      continue;
    }
    if (busy.start > f.start) out.push({ start: f.start, end: busy.start });
    if (busy.end < f.end) out.push({ start: busy.end, end: f.end });
  }
  return out;
}

function urgency(task: Task, dayEnd: Date, now: Date): { score: number; reason?: string } {
  if (!task.due) return { score: 15 };
  const due = new Date(task.due);
  const hours = (due.getTime() - dayEnd.getTime()) / 3600000;
  if (due < now) {
    const days = Math.max(1, Math.ceil((now.getTime() - due.getTime()) / 86400000));
    return { score: 100 + Math.min(days, 14) * 5, reason: days === 1 ? "overdue since yesterday" : `overdue by ${days} days` };
  }
  if (hours <= 0) return { score: 85, reason: "due today" };
  if (hours <= 24) return { score: 65, reason: "due tomorrow" };
  if (hours <= 72) return { score: 45, reason: "due in a few days" };
  if (hours <= 24 * 7) return { score: 28, reason: "due this week" };
  return { score: 10 };
}

function priorityScore(p: number): { score: number; reason?: string } {
  const score = (5 - p) * 15;
  return { score, reason: p === 1 ? "critical" : p === 2 ? "important" : undefined };
}

function ageScore(task: Task, now: Date): number {
  const days = (now.getTime() - new Date(task.createdAt).getTime()) / 86400000;
  return Math.min(Math.max(days, 0), 14);
}

function fitScore(task: Task, slotEnergy: Energy | undefined): { score: number; reason?: string } {
  if (!slotEnergy) return { score: 0 };
  if (slotEnergy === task.energy) {
    const label: Record<Energy, string> = {
      deep: "deep work in your focus window",
      light: "light work fits this stretch",
      admin: "admin fits your low-energy window",
      social: "social energy fits here",
    };
    return { score: 22, reason: label[task.energy] };
  }
  if (ENERGY_NEIGHBORS[slotEnergy].includes(task.energy)) return { score: 6 };
  if (task.energy === "deep" && slotEnergy === "admin") return { score: -12 };
  return { score: -4 };
}

export function planDay(input: PlannerInput): Plan {
  const { tz, prefs, now } = input;
  const cal = prefs.useCalibration ? input.calibration : undefined;
  const est = (t: Task) => Math.max(MIN_SLOT, calibratedEstimate(t, cal) || 30);
  const goalIds = new Set(input.goalIds ?? []);
  const dayStart = startOfDay(input.date, tz);
  const key = dayKey(dayStart, tz);
  const weekday = toZoned(dayStart, tz).weekday;
  const isWorkDay = prefs.workDays.includes(weekday);
  const isToday = sameDay(now, dayStart, tz);

  let windowStart = setTime(dayStart, Math.floor(prefs.workdayStartMin / 60), prefs.workdayStartMin % 60, tz);
  const windowEnd = setTime(dayStart, Math.floor(prefs.workdayEndMin / 60), prefs.workdayEndMin % 60, tz);
  if (isToday && now > windowStart) windowStart = roundUp(now, 5);

  const blocks: PlanBlock[] = [];
  let free: Interval[] = windowStart < windowEnd ? [{ start: windowStart, end: windowEnd }] : [];

  // --- Events (fixed) ---
  const dayEvents = input.events
    .filter((e) => !e.allDay && new Date(e.end) > dayStart && new Date(e.start) < addMinutes(dayStart, 24 * 60))
    .sort((a, b) => a.start.localeCompare(b.start));
  let meetingMin = 0;
  for (const e of dayEvents) {
    const s = new Date(e.start);
    const en = new Date(e.end);
    meetingMin += minutesBetween(s, en);
    blocks.push({ id: uid("blk"), kind: "event", title: e.title, start: s.toISOString(), end: en.toISOString(), eventId: e.id });
    const buffered: Interval = { start: addMinutes(s, -prefs.meetingBufferMin), end: addMinutes(en, prefs.meetingBufferMin) };
    free = subtract(free, buffered);
    if (prefs.meetingBufferMin > 0 && e.kind === "meeting") {
      blocks.push({ id: uid("blk"), kind: "buffer", title: "Buffer", start: buffered.start.toISOString(), end: s.toISOString() });
      blocks.push({ id: uid("blk"), kind: "buffer", title: "Buffer", start: en.toISOString(), end: buffered.end.toISOString() });
    }
  }

  // --- Pinned tasks (fixed) ---
  const open = input.tasks.filter((t) => t.status === "open" && (!t.snoozedUntil || new Date(t.snoozedUntil) <= addMinutes(dayStart, 24 * 60)));
  const pinnedToday = open.filter((t) => t.pinnedStart && sameDay(new Date(t.pinnedStart), dayStart, tz));
  for (const t of pinnedToday) {
    const s = new Date(t.pinnedStart!);
    const en = addMinutes(s, est(t));
    blocks.push({ id: uid("blk"), kind: "task", title: t.title, start: s.toISOString(), end: en.toISOString(), taskId: t.id, energy: t.energy, reason: "you pinned this time" });
    free = subtract(free, { start: s, end: en });
  }

  // --- Candidates ---
  const dayEnd = windowEnd;
  const candidates: Candidate[] = [];
  for (const t of open) {
    if (t.pinnedStart) continue; // pinned elsewhere or today (already placed)
    if (t.due && new Date(t.due) < dayStart && !isToday && new Date(t.due) > now) continue; // due before a future planning day: leave for earlier days
    const u = urgency(t, dayEnd, now);
    const p = priorityScore(t.priority);
    const a = ageScore(t, now);
    const reasons = [u.reason, p.reason].filter((r): r is string => !!r);
    let base = u.score + p.score + a;
    // Quick wins: a tiny task that's overdue or due today should be cleared, not deferred for energy fit.
    if ((t.estimateMin || 30) <= 20 && u.score >= 85) {
      base += 18;
      reasons.push("quick win");
    }
    if (t.goalId && goalIds.has(t.goalId)) {
      base += 12;
      reasons.push("serves a goal");
    }
    if (!isWorkDay) {
      const dueToday = t.due && sameDay(new Date(t.due), dayStart, tz);
      const overdue = t.due && new Date(t.due) < now;
      if (!dueToday && !overdue && t.priority > 1) continue; // protect the weekend
      base += 0;
    }
    const calibrated = est(t);
    if (cal && calibrated !== (t.estimateMin || 30)) reasons.push(`~${calibrated}m by your history`);
    candidates.push({ task: t, remainingMin: calibrated, base, reasons, parts: 0 });
  }

  // --- Greedy placement ---
  const totalFree = free.reduce((n, f) => n + minutesBetween(f.start, f.end), 0);
  let budget = Math.floor(totalFree * SLACK);
  let focusMin = 0;
  let breakMin = 0;
  let sinceBreak = 0;
  const placedTaskIds = new Set<string>();

  free.sort((a, b) => a.start.getTime() - b.start.getTime());
  for (const slot of free) {
    let cursor = slot.start;
    while (minutesBetween(cursor, slot.end) >= MIN_SLOT && budget >= MIN_SLOT) {
      const remaining = minutesBetween(cursor, slot.end);
      if (sinceBreak >= prefs.focusBlockMin && remaining > prefs.breakMin + MIN_SLOT) {
        const bEnd = addMinutes(cursor, prefs.breakMin);
        blocks.push({ id: uid("blk"), kind: "break", title: "Break", start: cursor.toISOString(), end: bEnd.toISOString(), reason: `after ${sinceBreak} min of focus` });
        breakMin += prefs.breakMin;
        cursor = bEnd;
        sinceBreak = 0;
        continue;
      }
      const slotEnergy = energyAt(prefs, minuteOfDay(cursor, tz));
      let best: { c: Candidate; score: number; fit: ReturnType<typeof fitScore>; chunk: number } | null = null;
      for (const c of candidates) {
        if (c.remainingMin <= 0) continue;
        const fit = fitScore(c.task, slotEnergy);
        const fits = c.remainingMin <= remaining && c.remainingMin <= budget;
        const canSplit = c.remainingMin > remaining && remaining >= MIN_SPLIT && c.remainingMin >= MIN_SPLIT * 2;
        if (!fits && !canSplit) continue;
        const chunk = fits ? c.remainingMin : Math.min(remaining, budget);
        const score = c.base + fit.score - (fits ? 0 : 8) - (c.parts > 0 ? 3 : 0);
        if (!best || score > best.score) best = { c, score, fit, chunk };
      }
      if (!best) break;
      const { c, fit, chunk } = best;
      const end = addMinutes(cursor, chunk);
      c.parts += 1;
      c.remainingMin -= chunk;
      const willSplit = c.remainingMin > 0;
      const reasons = [...c.reasons];
      if (fit.reason) reasons.push(fit.reason);
      if (willSplit || c.parts > 1) reasons.push(willSplit ? "split to fit the day" : "finishing an earlier chunk");
      blocks.push({
        id: uid("blk"),
        kind: "task",
        title: c.task.title,
        start: cursor.toISOString(),
        end: end.toISOString(),
        taskId: c.task.id,
        energy: c.task.energy,
        reason: reasons.slice(0, 3).join(" · ") || "highest remaining priority",
        part: willSplit || c.parts > 1 ? [c.parts, 0] : undefined,
      });
      placedTaskIds.add(c.task.id);
      focusMin += chunk;
      budget -= chunk;
      sinceBreak += chunk;
      cursor = end;
    }
    if (minutesBetween(cursor, slot.end) >= MIN_SLOT) {
      blocks.push({ id: uid("blk"), kind: "free", title: "Slack", start: cursor.toISOString(), end: slot.end.toISOString(), reason: "kept open on purpose" });
    }
  }

  // fix part totals
  const partTotals = new Map<string, number>();
  for (const b of blocks) if (b.part && b.taskId) partTotals.set(b.taskId, (partTotals.get(b.taskId) ?? 0) + 1);
  for (const b of blocks) if (b.part && b.taskId) b.part = [b.part[0], partTotals.get(b.taskId) ?? b.part[0]];

  blocks.sort((a, b) => a.start.localeCompare(b.start));

  const unscheduled = candidates
    .filter((c) => c.remainingMin > 0)
    .sort((a, b) => b.base - a.base)
    .map((c) => ({
      taskId: c.task.id,
      title: c.task.title,
      reason:
        c.parts > 0 ? `${c.remainingMin} min still unplaced`
        : est(c.task) > totalFree ? `needs ${est(c.task)} min; no window that long`
        : budget < MIN_SLOT ? "day is full (slack reserved)"
        : c.task.priority === 4 ? "someday — left out on purpose"
        : "lower priority than what made the cut",
    }));

  const freeMin = blocks.filter((b) => b.kind === "free").reduce((n, b) => n + minutesBetween(new Date(b.start), new Date(b.end)), 0);
  const available = Math.max(1, minutesBetween(windowStart, windowEnd));
  const committed = focusMin + meetingMin + pinnedToday.reduce((n, t) => n + est(t), 0);

  return {
    date: key,
    blocks,
    unscheduled,
    stats: {
      focusMin: focusMin + pinnedToday.reduce((n, t) => n + est(t), 0),
      meetingMin,
      breakMin,
      freeMin,
      loadPct: Math.min(100, Math.round((committed / available) * 100)),
      taskCount: placedTaskIds.size + pinnedToday.length,
    },
    generatedAt: now.toISOString(),
  };
}

/** The block that's happening now, and the one after it. */
export function currentAndNext(plan: Plan, now: Date): { current?: PlanBlock; next?: PlanBlock } {
  const t = now.getTime();
  const sorted = [...plan.blocks].filter((b) => b.kind !== "buffer").sort((a, b) => a.start.localeCompare(b.start));
  const current = sorted.find((b) => new Date(b.start).getTime() <= t && new Date(b.end).getTime() > t);
  const next = sorted.find((b) => new Date(b.start).getTime() > t && b.kind !== "free");
  return { current, next };
}
