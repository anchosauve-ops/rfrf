import { describe, it, expect } from "vitest";
import { simulateFutures, rng, DEFAULT_PREFERENCES, type Task, type Event } from "../src/core/index.js";

const tz = "UTC";
const now = new Date("2026-09-07T08:00:00Z"); // Monday 08:00
const prefs = { ...DEFAULT_PREFERENCES, timezone: tz };
const t = (id: string, extra: Partial<Task>): Task => ({ id, title: id, status: "open", priority: 3, energy: "light", estimateMin: 60, tags: [], peopleIds: [], source: "user", createdAt: "2026-09-01T00:00:00Z", updatedAt: "", ...extra });

describe("futures", () => {
  it("is deterministic for a seed", () => {
    const a = rng(7); const b = rng(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    const tasks = [t("a", { due: "2026-09-08T17:00:00Z", estimateMin: 120 }), t("b", { due: "2026-09-10T17:00:00Z", estimateMin: 300 })];
    const r1 = simulateFutures({ now, tz, prefs, tasks, events: [], seed: 5, runs: 100 });
    const r2 = simulateFutures({ now, tz, prefs, tasks, events: [], seed: 5, runs: 100 });
    expect(r1.risks).toEqual(r2.risks);
  });
  it("finds no risk in a light week and high risk in an impossible one", () => {
    const light = simulateFutures({ now, tz, prefs, tasks: [t("a", { due: "2026-09-11T17:00:00Z", estimateMin: 60 })], events: [], runs: 100 });
    expect(light.risks[0]!.pMiss).toBeLessThan(0.1);
    expect(light.risks[0]!.level).toBe("safe");
    const heavy = simulateFutures({ now, tz, prefs, tasks: [t("big", { due: "2026-09-08T17:00:00Z", estimateMin: 20 * 60, priority: 1 })], events: [], runs: 100 });
    expect(heavy.risks[0]!.pMiss).toBeGreaterThan(0.9);
    expect(heavy.risks[0]!.level).toBe("danger");
  });
  it("meetings consume capacity and interventions reduce risk", () => {
    const events: Event[] = Array.from({ length: 5 }, (_, i) => ({ id: `e${i}`, title: "mtg", start: new Date(Date.UTC(2026, 8, 7 + i, 9, 0)).toISOString(), end: new Date(Date.UTC(2026, 8, 7 + i, 15, 0)).toISOString(), allDay: false, kind: "meeting", peopleIds: [], source: "user", createdAt: "", updatedAt: "" }));
    const tasks = [
      t("crit", { due: "2026-09-09T17:00:00Z", estimateMin: 6 * 60, priority: 1 }),
      t("filler1", { estimateMin: 120, priority: 3 }),
      t("filler2", { estimateMin: 120, priority: 3 }),
      t("later", { due: "2026-09-30T17:00:00Z", estimateMin: 180, priority: 3 }),
    ];
    const r = simulateFutures({ now, tz, prefs, tasks, events, runs: 120 });
    expect(r.capacity.availableMin).toBeLessThan(5 * 9 * 60);
    expect(r.loadByDay.length).toBe(7);
    const crit = r.risks.find((x) => x.taskId === "crit")!;
    expect(crit.pMiss).toBeGreaterThan(0.2);
    expect(r.interventions.length).toBeGreaterThan(0);
    expect(r.interventions[0]!.riskDelta).toBeGreaterThan(0);
    expect(r.interventions.every((i, idx, arr) => idx === 0 || arr[idx - 1]!.riskDelta >= i.riskDelta)).toBe(true);
  });
  it("respects calibration: underestimated deep work raises risk", () => {
    const tasks = [t("deep", { energy: "deep", due: "2026-09-08T12:00:00Z", estimateMin: 150, priority: 2 })];
    const base = simulateFutures({ now, tz, prefs, tasks, events: [], runs: 150 });
    const cal = { estimateBias: { deep: { factor: 2.2, n: 10, confidence: 0.7 }, light: { factor: 1, n: 0, confidence: 0 }, admin: { factor: 1, n: 0, confidence: 0 }, social: { factor: 1, n: 0, confidence: 0 } }, hourPropensity: [], peakHours: { deep: [], light: [], admin: [], social: [] }, planAdherence: { rate: 0.5, n: 10 }, slipRate: { byEnergy: { deep: 0, light: 0, admin: 0, social: 0 }, byTag: {}, overall: 0, n: 0 }, sampleSize: 10, generatedAt: "" };
    const withCal = simulateFutures({ now, tz, prefs, tasks, events: [], runs: 150, calibration: cal });
    expect(withCal.risks[0]!.pMiss).toBeGreaterThan(base.risks[0]!.pMiss);
  });
});
