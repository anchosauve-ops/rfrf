import { describe, it, expect } from "vitest";
import { fitCalibration, calibratedEstimate, outcomeFromTask, describeCalibration, DEFAULT_PREFERENCES, type Outcome, type Task } from "../src/core/index.js";

const prefs = { ...DEFAULT_PREFERENCES, timezone: "UTC" };
const now = new Date("2026-09-03T12:00:00Z");
const o = (i: number, extra: Partial<Outcome>): Outcome => ({ id: `o${i}`, taskId: `t${i}`, title: `t${i}`, energy: "deep", tags: [], estimateMin: 60, completedAt: "2026-09-01T10:00:00Z", hour: 10, weekday: 2, slipped: false, ...extra });

describe("learning", () => {
  it("shrinks toward priors with no data and learns bias with data", () => {
    const empty = fitCalibration([], prefs, now);
    expect(empty.estimateBias.deep.factor).toBeCloseTo(1.35, 1);
    expect(empty.estimateBias.deep.n).toBe(0);
    const outcomes = Array.from({ length: 12 }, (_, i) => o(i, { energy: "deep", estimateMin: 60, actualMin: 120 }));
    const cal = fitCalibration(outcomes, prefs, now);
    expect(cal.estimateBias.deep.factor).toBeGreaterThan(1.6);
    expect(cal.estimateBias.deep.factor).toBeLessThan(2.0);
    expect(cal.estimateBias.deep.n).toBe(12);
    expect(cal.estimateBias.admin.n).toBe(0);
  });
  it("finds peak hours and hour propensity", () => {
    const outcomes = [
      ...Array.from({ length: 6 }, (_, i) => o(i, { energy: "deep", hour: 9 })),
      ...Array.from({ length: 3 }, (_, i) => o(10 + i, { energy: "deep", hour: 10 })),
      ...Array.from({ length: 5 }, (_, i) => o(20 + i, { energy: "admin", hour: 16 })),
    ];
    const cal = fitCalibration(outcomes, prefs, now);
    expect(cal.peakHours.deep[0]).toBe(9);
    expect(cal.peakHours.admin[0]).toBe(16);
    expect(cal.hourPropensity[9]).toBe(1);
    expect(cal.hourPropensity[3]).toBe(0);
  });
  it("proposes an energy curve once evidence is strong", () => {
    const outcomes = [
      ...Array.from({ length: 15 }, (_, i) => o(i, { energy: "deep", hour: 9 + (i % 2) })),
      ...Array.from({ length: 12 }, (_, i) => o(100 + i, { energy: "admin", hour: 15 + (i % 2) })),
    ];
    const cal = fitCalibration(outcomes, prefs, now);
    expect(cal.proposedCurve).toBeDefined();
    const nine = cal.proposedCurve!.find((s) => s.fromMin <= 9 * 60 && s.toMin > 9 * 60);
    const fifteen = cal.proposedCurve!.find((s) => s.fromMin <= 15 * 60 && s.toMin > 15 * 60);
    expect(nine?.best).toBe("deep");
    expect(fifteen?.best).toBe("admin");
  });
  it("calibratedEstimate rounds to 5 and ignores energies without data", () => {
    const outcomes = Array.from({ length: 10 }, (_, i) => o(i, { energy: "deep", estimateMin: 30, actualMin: 45 }));
    const cal = fitCalibration(outcomes, prefs, now);
    expect(calibratedEstimate({ estimateMin: 60, energy: "deep" }, cal) % 5).toBe(0);
    expect(calibratedEstimate({ estimateMin: 60, energy: "deep" }, cal)).toBeGreaterThan(60);
    expect(calibratedEstimate({ estimateMin: 60, energy: "social" }, cal)).toBe(60);
  });
  it("builds outcomes from tasks with slip and on-plan flags", () => {
    const task: Task = { id: "t", title: "x", status: "done", priority: 2, energy: "admin", estimateMin: 20, due: "2026-09-01T00:00:00Z", plannedStart: "2026-09-03T09:00:00Z", tags: ["admin"], peopleIds: [], source: "user", createdAt: "", updatedAt: "" };
    const out = outcomeFromTask(task, { completedAt: now, hour: 12, weekday: 4, plannedDay: "2026-09-03", completedDay: "2026-09-03" });
    expect(out.slipped).toBe(true);
    expect(out.onPlan).toBe(true);
  });
  it("describes what it learned in plain sentences", () => {
    const outcomes = Array.from({ length: 8 }, (_, i) => o(i, { energy: "deep", estimateMin: 60, actualMin: 100, hour: 9 }));
    const lines = describeCalibration(fitCalibration(outcomes, prefs, now));
    expect(lines.some((l) => /underestimate deep work/.test(l))).toBe(true);
  });
});
