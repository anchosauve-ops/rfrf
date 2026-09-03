import { describe, it, expect } from "vitest";
import { localCouncil, alignment, derivedProgress, pace, DEFAULT_PREFERENCES, type Task, type Goal, type Plan } from "../src/core/index.js";

const now = new Date("2026-09-03T12:00:00Z");
const prefs = { ...DEFAULT_PREFERENCES, timezone: "UTC" };
const t = (id: string, extra: Partial<Task>): Task => ({ id, title: id, status: "open", priority: 3, energy: "light", estimateMin: 60, tags: [], peopleIds: [], source: "user", createdAt: "2026-07-01T00:00:00Z", updatedAt: "", ...extra });
const goal: Goal = { id: "g1", title: "Ship v1", horizon: "quarter", targetDate: "2026-10-31T00:00:00Z", progress: 0.2, status: "active", pinned: true, createdAt: "2026-08-01T00:00:00Z", updatedAt: "" };

describe("council (local)", () => {
  it("raises a strategist warning without goals and an editor note for stale undated tasks", () => {
    const v = localCouncil({ now, tz: "UTC", prefs, tasks: [t("old", {}), t("s1", { priority: 4 }), t("s2", { priority: 4 }), t("s3", { priority: 4 })], events: [], people: [], memories: [], goals: [] });
    expect(v.findings.some((f) => f.perspective === "strategist" && /no stated goal/i.test(f.claim))).toBe(true);
    expect(v.findings.some((f) => f.perspective === "editor" && /someday/.test(f.claim))).toBe(true);
    expect(v.findings.some((f) => f.perspective === "editor" && /open \d+ days/.test(f.claim))).toBe(true);
    expect(v.mode).toBe("local");
    expect(v.decision.length).toBeGreaterThan(0);
  });
  it("orders critical before notes and surfaces realist risk", () => {
    const risk = { horizonDays: 7, runs: 100, risks: [{ taskId: "a", title: "Big thing", due: "2026-09-04T00:00:00Z", priority: 1 as const, pMiss: 0.8, expectedDay: "2026-09-06", expectedAt: "", level: "danger" as const }], interventions: [{ id: "x", kind: "defer" as const, title: "Push filler", detail: "", riskDelta: 0.3, command: "move filler to next week" }], capacity: { availableMin: 1000, demandedMin: 1500, ratio: 1.5 }, loadByDay: [], generatedAt: "", seed: 1 };
    const v = localCouncil({ now, tz: "UTC", prefs, tasks: [t("a", { priority: 1, due: "2026-09-04T00:00:00Z" })], events: [], people: [], memories: [], goals: [goal], risk });
    expect(v.findings[0]!.severity).toBe("critical");
    expect(v.findings[0]!.perspective).toBe("realist");
    expect(v.findings[0]!.command).toBe("move filler to next week");
    expect(v.findings.some((f) => /committed 150%/.test(f.claim))).toBe(true);
  });
  it("connector notices drifting people", () => {
    const v = localCouncil({ now, tz: "UTC", prefs, tasks: [], events: [], people: [{ id: "p", name: "Sam", tags: [], cadenceDays: 14, lastContactAt: "2026-08-01T00:00:00Z", createdAt: "", updatedAt: "" }], memories: [], goals: [goal] });
    expect(v.findings.some((f) => f.perspective === "connector" && /Sam/.test(f.claim))).toBe(true);
  });
});

describe("goals", () => {
  it("computes alignment from a plan and derived progress from tasks", () => {
    const tasks = [t("a", { goalId: "g1", status: "done" }), t("b", { goalId: "g1" }), t("c", {})];
    const plan: Plan = { date: "2026-09-03", blocks: [
      { id: "1", kind: "task", title: "b", start: "2026-09-03T09:00:00Z", end: "2026-09-03T10:00:00Z", taskId: "b" },
      { id: "2", kind: "task", title: "c", start: "2026-09-03T10:00:00Z", end: "2026-09-03T13:00:00Z", taskId: "c" },
    ], unscheduled: [], stats: { focusMin: 240, meetingMin: 0, breakMin: 0, freeMin: 0, loadPct: 50, taskCount: 2 }, generatedAt: "" };
    const al = alignment([goal], tasks, { plan });
    expect(al[0]!.focusMin).toBe(60);
    expect(al[0]!.share).toBeCloseTo(0.25);
    expect(al[0]!.openTasks).toBe(1);
    expect(derivedProgress(goal, tasks)).toBeCloseTo(0.5);
    const p = pace(goal, now)!;
    expect(p.expected).toBeGreaterThan(0.3);
    expect(p.onPace).toBe(false);
  });
});
