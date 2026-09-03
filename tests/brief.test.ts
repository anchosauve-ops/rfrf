import { describe, it, expect } from "vitest";
import { composeBrief, briefToText } from "../src/core/brief";
import { DEFAULT_PREFERENCES, type Task, type Event, type Person } from "../src/core/types";

const tz = "America/New_York";
const now = new Date("2026-09-03T12:30:00Z");
const prefs = { ...DEFAULT_PREFERENCES, timezone: tz, name: "Will" };
const T = (id: string, title: string, extra: Partial<Task> = {}): Task => ({ id, title, status: "open", priority: 3, energy: "light", estimateMin: 30, tags: [], peopleIds: [], source: "user", createdAt: "2026-08-30T00:00:00Z", updatedAt: "2026-08-30T00:00:00Z", ...extra });
const E = (id: string, title: string, start: string, end: string): Event => ({ id, title, start, end, allDay: false, kind: "meeting", peopleIds: [], source: "user", createdAt: "", updatedAt: "" });
const P = (id: string, name: string, extra: Partial<Person> = {}): Person => ({ id, name, tags: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "", ...extra });

describe("brief", () => {
  it("morning brief surfaces schedule, top three, slipped, drifting people, north star", () => {
    const b = composeBrief({
      kind: "morning", now, tz, prefs,
      tasks: [T("1", "Overdue thing", { due: "2026-09-01T00:00:00Z" }), T("2", "Due today", { due: "2026-09-03T20:00:00Z", priority: 2 }), T("3", "Later", { priority: 4 })],
      events: [E("e", "Standup", "2026-09-03T13:30:00Z", "2026-09-03T13:45:00Z")],
      people: [P("p", "Sam", { cadenceDays: 14, lastContactAt: "2026-08-01T00:00:00Z", relation: "mentor" })],
      memories: [{ id: "m", text: "Ship v1 by October", kind: "goal", tags: [], importance: 0.9, confidence: 0.9, source: "stated", pinned: true, accessCount: 0, createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z" }],
    });
    expect(b.greeting).toBe("Good morning, Will.");
    expect(b.headline).toMatch(/1 event/);
    const ids = b.sections.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(["schedule", "top3", "overdue", "people", "north"]));
    expect(b.sections.find((s) => s.id === "top3")!.lines[0]).toMatch(/Due today/);
    expect(briefToText(b)).toContain("NORTH STAR");
  });
  it("clear day gets the clear-day headline", () => {
    const b = composeBrief({ kind: "morning", now, tz, prefs, tasks: [], events: [], people: [], memories: [] });
    expect(b.headline).toBe("A clear day. Protect it.");
  });
  it("evening review counts done and carried", () => {
    const b = composeBrief({ kind: "evening", now, tz, prefs, tasks: [T("d", "Done", { status: "done", completedAt: "2026-09-03T15:00:00Z" })], events: [], people: [], memories: [] });
    expect(b.headline).toMatch(/1 done/);
    expect(b.sections.find((s) => s.id === "reflect")).toBeTruthy();
  });
  it("weekly retro has metrics", () => {
    const b = composeBrief({ kind: "weekly", now, tz, prefs, tasks: [T("d", "Done", { status: "done", completedAt: "2026-09-01T15:00:00Z" })], events: [], people: [], memories: [] });
    expect(b.sections[0]!.cards?.[0]?.type).toBe("metrics");
  });
});
