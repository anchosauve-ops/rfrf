import { describe, it, expect } from "vitest";
import { planDay, currentAndNext } from "../src/core/planner";
import { DEFAULT_PREFERENCES, type Task, type Event } from "../src/core/types";

const tz = "America/New_York";
const prefs = { ...DEFAULT_PREFERENCES, timezone: tz };
const now = new Date("2026-09-03T12:30:00Z"); // 08:30 local, Thursday
const T = (id: string, title: string, extra: Partial<Task> = {}): Task => ({ id, title, status: "open", priority: 3, energy: "light", estimateMin: 30, tags: [], peopleIds: [], source: "user", createdAt: "2026-08-30T00:00:00Z", updatedAt: "2026-08-30T00:00:00Z", ...extra });
const E = (id: string, title: string, start: string, end: string, kind: Event["kind"] = "meeting"): Event => ({ id, title, start, end, allDay: false, kind, peopleIds: [], source: "user", createdAt: "", updatedAt: "" });

describe("planner", () => {
  it("never overlaps events and adds buffers around meetings", () => {
    const events = [E("e1", "Standup", "2026-09-03T13:30:00Z", "2026-09-03T13:45:00Z")];
    const tasks = [T("1", "Deep thing", { energy: "deep", estimateMin: 120, priority: 2 })];
    const plan = planDay({ date: now, now, tz, tasks, events, prefs });
    const taskBlocks = plan.blocks.filter((b) => b.kind === "task");
    for (const b of taskBlocks) {
      const s = new Date(b.start).getTime(), e = new Date(b.end).getTime();
      const es = new Date(events[0]!.start).getTime() - 5 * 60000, ee = new Date(events[0]!.end).getTime() + 5 * 60000;
      expect(e <= es || s >= ee).toBe(true);
    }
    expect(plan.blocks.some((b) => b.kind === "buffer")).toBe(true);
  });

  it("puts overdue + critical first, respects pins, splits long tasks, keeps slack", () => {
    const tasks = [
      T("a", "Overdue invoice", { energy: "admin", estimateMin: 15, priority: 2, due: "2026-09-02T22:00:00Z" }),
      T("b", "Write update", { energy: "deep", estimateMin: 150, priority: 2, due: "2026-09-03T22:00:00Z" }),
      T("c", "Call mom", { energy: "social", estimateMin: 30, pinnedStart: "2026-09-03T21:00:00Z" }),
      T("d", "Someday reading", { energy: "deep", estimateMin: 60, priority: 4 }),
    ];
    const events = [E("e1", "Lunch", "2026-09-03T16:30:00Z", "2026-09-03T17:30:00Z", "personal")];
    const plan = planDay({ date: now, now, tz, tasks, events, prefs });
    const first = plan.blocks.find((b) => b.kind === "task");
    expect(first?.taskId).toBe("a");
    expect(first?.reason).toMatch(/overdue/);
    const pinned = plan.blocks.find((b) => b.taskId === "c");
    expect(pinned?.start).toBe("2026-09-03T21:00:00.000Z");
    expect(pinned?.reason).toMatch(/pinned/);
    const writeBlocks = plan.blocks.filter((b) => b.taskId === "b");
    expect(writeBlocks.length).toBeGreaterThanOrEqual(1);
    expect(writeBlocks.reduce((n, b) => n + (new Date(b.end).getTime() - new Date(b.start).getTime()) / 60000, 0)).toBe(150);
    // someday work is allowed in when there's room, but never ahead of the real work
    const dBlock = plan.blocks.find((b) => b.taskId === "d");
    if (dBlock) expect(new Date(dBlock.start).getTime()).toBeGreaterThan(new Date(writeBlocks[0]!.start).getTime());
    else expect(plan.unscheduled.find((u) => u.taskId === "d")?.reason).toMatch(/someday|full|lower/);
    expect(plan.stats.loadPct).toBeLessThanOrEqual(100);
    expect(plan.blocks.some((b) => b.kind === "free" || b.kind === "break")).toBe(true);
    expect(plan.stats.taskCount).toBeGreaterThanOrEqual(3);
  });

  it("prefers deep work in the morning window and admin in the trough", () => {
    const tasks = [T("deep", "Design system", { energy: "deep", estimateMin: 90 }), T("admin", "Expenses", { energy: "admin", estimateMin: 30 })];
    const plan = planDay({ date: now, now, tz, tasks, events: [], prefs });
    const deep = plan.blocks.find((b) => b.taskId === "deep")!;
    const admin = plan.blocks.find((b) => b.taskId === "admin")!;
    expect(new Date(deep.start).getTime()).toBeLessThan(new Date(admin.start).getTime());
    expect(deep.reason).toMatch(/focus window/);
  });

  it("starts from now when planning today mid-day", () => {
    const late = new Date("2026-09-03T18:07:00Z"); // 14:07 local
    const plan = planDay({ date: late, now: late, tz, tasks: [T("x", "Thing")], events: [], prefs });
    const first = plan.blocks.find((b) => b.kind === "task")!;
    expect(new Date(first.start).getTime()).toBeGreaterThanOrEqual(late.getTime());
    expect(new Date(first.start).getUTCMinutes() % 5).toBe(0);
  });

  it("protects weekends: only due/overdue/critical tasks", () => {
    const sat = new Date("2026-09-05T12:00:00Z");
    const tasks = [T("chore", "Random chore"), T("due", "Due Saturday", { due: "2026-09-05T20:00:00Z" })];
    const plan = planDay({ date: sat, now: sat, tz, tasks, events: [], prefs });
    expect(plan.blocks.some((b) => b.taskId === "due")).toBe(true);
    expect(plan.blocks.some((b) => b.taskId === "chore")).toBe(false);
  });

  it("currentAndNext finds the live block", () => {
    const plan = planDay({ date: now, now, tz, tasks: [T("x", "Thing", { estimateMin: 60 })], events: [], prefs });
    const first = plan.blocks.find((b) => b.kind === "task")!;
    const mid = new Date((new Date(first.start).getTime() + new Date(first.end).getTime()) / 2);
    expect(currentAndNext(plan, mid).current?.id).toBe(first.id);
  });
});
