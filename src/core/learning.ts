/**
 * Learning — the symbiotic loop. Every completed task is a prediction that
 * met reality. From the residue we fit a small, honest model of the person:
 * how far off their estimates run per kind of work, when each kind of work
 * actually gets done, what slips, and how often the plan survives contact
 * with the day. The planner consumes it; the Mirror shows it.
 *
 * Deliberately simple statistics with shrinkage toward priors, so it behaves
 * with 5 data points and with 5,000.
 */
import type { Calibration, Energy, EnergySlot, Outcome, Preferences, Task } from "./types.js";

const ENERGIES: Energy[] = ["deep", "light", "admin", "social"];
const PRIOR_FACTOR: Record<Energy, number> = { deep: 1.35, light: 1.1, admin: 1.05, social: 1.0 };
const PRIOR_WEIGHT = 4; // pseudo-observations

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function fitCalibration(outcomes: Outcome[], prefs: Preferences, now = new Date()): Calibration {
  const estimateBias = {} as Calibration["estimateBias"];
  for (const e of ENERGIES) {
    const ratios = outcomes.filter((o) => o.energy === e && o.actualMin && o.estimateMin > 0).map((o) => Math.min(6, Math.max(0.2, o.actualMin! / o.estimateMin)));
    const n = ratios.length;
    // shrink the log-median toward the prior
    const logMed = n ? Math.log(median(ratios)) : Math.log(PRIOR_FACTOR[e]);
    const w = n / (n + PRIOR_WEIGHT);
    const factor = Math.exp(w * logMed + (1 - w) * Math.log(PRIOR_FACTOR[e]));
    estimateBias[e] = { factor: Math.round(factor * 100) / 100, n, confidence: Math.round(w * 100) / 100 };
  }

  const hourCounts = new Array<number>(24).fill(0);
  const hourByEnergy: Record<Energy, number[]> = { deep: new Array(24).fill(0), light: new Array(24).fill(0), admin: new Array(24).fill(0), social: new Array(24).fill(0) };
  for (const o of outcomes) {
    if (!ENERGIES.includes(o.energy) || !(o.hour >= 0 && o.hour < 24)) continue; // tolerate malformed history
    const weight = Math.max(15, o.actualMin ?? o.estimateMin) / 30; // longer work counts more
    hourCounts[o.hour] = (hourCounts[o.hour] ?? 0) + weight;
    hourByEnergy[o.energy][o.hour] = (hourByEnergy[o.energy][o.hour] ?? 0) + weight;
  }
  const max = Math.max(1, ...hourCounts);
  const hourPropensity = hourCounts.map((c) => Math.round((c / max) * 100) / 100);
  const peakHours = {} as Calibration["peakHours"];
  for (const e of ENERGIES) {
    peakHours[e] = hourByEnergy[e]
      .map((v, h) => ({ v, h }))
      .filter((x) => x.v > 0)
      .sort((a, b) => b.v - a.v)
      .slice(0, 4)
      .map((x) => x.h);
  }

  const planned = outcomes.filter((o) => o.onPlan !== undefined);
  const planAdherence = { rate: planned.length ? Math.round((planned.filter((o) => o.onPlan).length / planned.length) * 100) / 100 : 0, n: planned.length };

  const dated = outcomes.filter((o) => o.slipped !== undefined);
  const byEnergy = {} as Record<Energy, number>;
  for (const e of ENERGIES) {
    const xs = dated.filter((o) => o.energy === e);
    byEnergy[e] = xs.length ? Math.round((xs.filter((o) => o.slipped).length / xs.length) * 100) / 100 : 0;
  }
  const byTag: Record<string, number> = {};
  const tagCounts: Record<string, [number, number]> = {};
  for (const o of dated) for (const t of o.tags) { const c = (tagCounts[t] ??= [0, 0]); c[1]++; if (o.slipped) c[0]++; }
  for (const [t, [s, n]] of Object.entries(tagCounts)) if (n >= 3) byTag[t] = Math.round((s / n) * 100) / 100;
  const slipRate = { byEnergy, byTag, overall: dated.length ? Math.round((dated.filter((o) => o.slipped).length / dated.length) * 100) / 100 : 0, n: dated.length };

  const proposedCurve = outcomes.length >= 25 ? proposeCurve(hourByEnergy, prefs) : undefined;

  return { estimateBias, hourPropensity, peakHours, planAdherence, slipRate, proposedCurve, sampleSize: outcomes.length, generatedAt: now.toISOString() };
}

/** Build a 2-hour-window energy curve from where each kind of work actually happens. */
export function proposeCurve(hourByEnergy: Record<Energy, number[]>, prefs: Preferences): EnergySlot[] {
  const startH = Math.floor(prefs.workdayStartMin / 60);
  const endH = Math.ceil(prefs.workdayEndMin / 60);
  const slots: EnergySlot[] = [];
  for (let h = startH; h < endH; h += 2) {
    let best: Energy = "light";
    let bestV = -1;
    for (const e of ENERGIES) {
      const v = (hourByEnergy[e][h] ?? 0) + (hourByEnergy[e][h + 1] ?? 0);
      // normalize by how much of that energy exists overall so a rare kind can still win its true hour
      const total = hourByEnergy[e].reduce((a, b) => a + b, 0) || 1;
      const score = v / total;
      if (score > bestV) { bestV = score; best = e; }
    }
    slots.push({ fromMin: h * 60, toMin: Math.min(endH, h + 2) * 60, best });
  }
  // merge adjacent identical slots
  const merged: EnergySlot[] = [];
  for (const s of slots) {
    const last = merged[merged.length - 1];
    if (last && last.best === s.best && last.toMin === s.fromMin) last.toMin = s.toMin;
    else merged.push({ ...s });
  }
  return merged;
}

/** The planner's view of a task's true cost. */
export function calibratedEstimate(task: Pick<Task, "estimateMin" | "energy">, cal?: Calibration): number {
  if (!cal) return task.estimateMin;
  const b = cal.estimateBias[task.energy];
  if (!b || b.n === 0) return task.estimateMin;
  return Math.round((task.estimateMin * b.factor) / 5) * 5;
}

/** Turn a completed task into an outcome record. */
export function outcomeFromTask(task: Task, opts: { completedAt: Date; hour: number; weekday: number; actualMin?: number; plannedDay?: string; completedDay: string }): Omit<Outcome, "id"> {
  return {
    taskId: task.id,
    title: task.title,
    energy: task.energy,
    tags: task.tags,
    goalId: task.goalId,
    estimateMin: task.estimateMin,
    actualMin: opts.actualMin,
    plannedStart: task.plannedStart,
    completedAt: opts.completedAt.toISOString(),
    hour: opts.hour,
    weekday: opts.weekday,
    slipped: !!task.due && new Date(task.due) < opts.completedAt,
    onPlan: opts.plannedDay ? opts.plannedDay === opts.completedDay : undefined,
  };
}

/** Human sentences about what was learned. Used for the Mirror and for nightly insight memories. */
export function describeCalibration(cal: Calibration): string[] {
  const out: string[] = [];
  for (const e of ENERGIES) {
    const b = cal.estimateBias[e];
    if (b.n >= 3 && Math.abs(b.factor - 1) >= 0.15) {
      out.push(b.factor > 1 ? `You underestimate ${e} work by about ${Math.round((b.factor - 1) * 100)}% (${b.n} samples).` : `You overestimate ${e} work by about ${Math.round((1 - b.factor) * 100)}% (${b.n} samples).`);
    }
  }
  const peakDeep = cal.peakHours.deep;
  if (peakDeep.length >= 2) out.push(`Your deep work actually lands around ${peakDeep.slice(0, 2).map(fmtHour).join(" and ")}.`);
  if (cal.planAdherence.n >= 5) out.push(`${Math.round(cal.planAdherence.rate * 100)}% of planned tasks get done on the day they were planned.`);
  if (cal.slipRate.n >= 5 && cal.slipRate.overall >= 0.25) out.push(`${Math.round(cal.slipRate.overall * 100)}% of dated tasks slip past their due date.`);
  const worstTag = Object.entries(cal.slipRate.byTag).sort((a, b) => b[1] - a[1])[0];
  if (worstTag && worstTag[1] >= 0.4) out.push(`#${worstTag[0]} tasks slip ${Math.round(worstTag[1] * 100)}% of the time.`);
  return out;
}

export function fmtHour(h: number): string {
  const ampm = h < 12 ? "am" : "pm";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}${ampm}`;
}
