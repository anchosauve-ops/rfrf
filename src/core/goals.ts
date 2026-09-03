import type { Goal, Outcome, Plan, Task } from "./types.js";

export interface Alignment {
  goalId: string;
  title: string;
  focusMin: number;
  share: number; // 0..1 of all focus minutes
  openTasks: number;
}

/** Where the focus went (planned or actual) relative to goals. */
export function alignment(goals: Goal[], tasks: Task[], opts: { plan?: Plan; outcomes?: Outcome[] }): Alignment[] {
  const minutesByGoal = new Map<string, number>();
  let total = 0;
  if (opts.plan) {
    for (const b of opts.plan.blocks) {
      if (b.kind !== "task" || !b.taskId) continue;
      const min = (new Date(b.end).getTime() - new Date(b.start).getTime()) / 60000;
      const t = tasks.find((x) => x.id === b.taskId);
      total += min;
      if (t?.goalId) minutesByGoal.set(t.goalId, (minutesByGoal.get(t.goalId) ?? 0) + min);
    }
  }
  for (const o of opts.outcomes ?? []) {
    const min = o.actualMin ?? o.estimateMin;
    total += min;
    if (o.goalId) minutesByGoal.set(o.goalId, (minutesByGoal.get(o.goalId) ?? 0) + min);
  }
  return goals
    .filter((g) => g.status === "active")
    .map((g) => ({
      goalId: g.id,
      title: g.title,
      focusMin: Math.round(minutesByGoal.get(g.id) ?? 0),
      share: total ? (minutesByGoal.get(g.id) ?? 0) / total : 0,
      openTasks: tasks.filter((t) => t.status === "open" && t.goalId === g.id).length,
    }))
    .sort((a, b) => b.focusMin - a.focusMin);
}

/** Progress derived from linked tasks when the person hasn't set it by hand. */
export function derivedProgress(goal: Goal, tasks: Task[]): number {
  const linked = tasks.filter((t) => t.goalId === goal.id && t.status !== "dropped");
  if (!linked.length) return goal.progress;
  const done = linked.filter((t) => t.status === "done").length;
  return Math.max(goal.progress, done / linked.length);
}

/** Days remaining vs progress: are we on pace? */
export function pace(goal: Goal, now: Date): { onPace: boolean; expected: number; delta: number } | undefined {
  if (!goal.targetDate) return undefined;
  const start = new Date(goal.createdAt).getTime();
  const end = new Date(goal.targetDate).getTime();
  if (end <= start) return undefined;
  const expected = Math.min(1, Math.max(0, (now.getTime() - start) / (end - start)));
  const delta = goal.progress - expected;
  return { onPace: delta >= -0.1, expected, delta };
}
