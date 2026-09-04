/**
 * Regressions from the final review. Each test names the defect it pins.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createApp, seedDemo, sanitizeImport } from "../src/server/app.js";
import { planDay, simulateFutures, parseIntent, DEFAULT_PREFERENCES, type Task } from "../src/core/index.js";
import { ritualPatch } from "../src/server/validate.js";

const now = () => new Date("2026-09-03T12:30:00Z");
const tz = "America/New_York";
const t = (id: string, extra: Partial<Task>): Task => ({ id, title: id, status: "open", priority: 3, energy: "light", estimateMin: 60, tags: [], peopleIds: [], source: "user", createdAt: "2026-09-01T00:00:00Z", updatedAt: "", ...extra });

describe("core regressions", () => {
  it("planDay is deterministic for identical inputs (ids included)", () => {
    const prefs = { ...DEFAULT_PREFERENCES, timezone: tz };
    const tasks = [t("a", { due: "2026-09-03T21:00:00Z" }), t("b", { energy: "deep", estimateMin: 120 })];
    const p1 = planDay({ date: now(), now: now(), tz, tasks, events: [], prefs });
    const p2 = planDay({ date: now(), now: now(), tz, tasks, events: [], prefs });
    expect(p1).toEqual(p2);
  });
  it("futures respects snoozedUntil: a deferred task no longer competes or gets re-suggested", () => {
    const prefs = { ...DEFAULT_PREFERENCES, timezone: "UTC" };
    const mon = new Date("2026-09-07T08:00:00Z");
    const crit = t("crit", { priority: 1, due: "2026-09-08T17:00:00Z", estimateMin: 8 * 60 });
    const filler = t("filler", { estimateMin: 6 * 60 });
    const before = simulateFutures({ now: mon, tz: "UTC", prefs, tasks: [crit, filler], events: [], runs: 100 });
    const deferSuggested = before.interventions.some((i) => i.targetTaskId === "filler" && i.kind === "defer");
    expect(deferSuggested).toBe(true);
    const after = simulateFutures({ now: mon, tz: "UTC", prefs, tasks: [crit, { ...filler, snoozedUntil: "2026-09-21T00:00:00Z" }], events: [], runs: 100 });
    expect(after.interventions.some((i) => i.targetTaskId === "filler")).toBe(false);
    expect(after.risks.find((r) => r.taskId === "crit")!.pMiss).toBeLessThanOrEqual(before.risks.find((r) => r.taskId === "crit")!.pMiss);
  });
  it("'move X to eod' honors the configured workday end", () => {
    const r = parseIntent("move the report to eod", { now: now(), tz, workdayEndMin: 17 * 60 });
    expect(r.intent.type).toBe("reschedule_task");
    expect((r.intent as { when: string }).when).toBe("2026-09-03T21:00:00.000Z"); // 17:00 New York
  });
  it("ritualPatch leaves freq alone when only time is sent", () => {
    const p = ritualPatch({ rule: { time: "17:00" } });
    expect(p.rule?.freq).toBeUndefined();
    expect(p.rule?.time).toBe("17:00");
  });
});

describe("server regressions", () => {
  const ctx = createApp({ now, webDir: "/nonexistent", log: false });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await ctx.app.request(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  beforeAll(() => {
    ctx.repo.setPrefs({ timezone: tz, name: "Will", onboarded: true, autonomy: "guardian" });
    seedDemo(ctx.repo, now());
  });

  it("a bogus energy from a tool call is coerced, and calibration survives malformed history", async () => {
    const r = await call("POST", "/api/tasks", { title: "weird", energy: "bogus", priority: 99, estimate_min: 1 });
    expect(r.status).toBe(201);
    expect(["deep", "light", "admin", "social"]).toContain(r.body.energy);
    expect(r.body.priority).toBe(4);
    expect(r.body.estimateMin).toBe(5);
    ctx.repo.addOutcome({ taskId: "x", title: "x", energy: "bogus" as never, tags: [], estimateMin: 30, completedAt: now().toISOString(), hour: 99, weekday: 1, slipped: false });
    expect(() => ctx.svc.calibration(now())).not.toThrow();
  });
  it("planning a future day does not clobber today's placements", async () => {
    const todayPlan = ctx.svc.plan(now(), now());
    const placed = todayPlan.blocks.find((b) => b.kind === "task" && b.taskId)!;
    const beforeTask = ctx.repo.getTask(placed.taskId!)!;
    expect(beforeTask.plannedStart).toBe(placed.start);
    ctx.svc.plan("2026-09-04", now());
    expect(ctx.repo.getTask(placed.taskId!)!.plannedStart).toBe(placed.start);
  });
  it("guardian defer is undoable, and the ledger patch survives JSON", async () => {
    const filler = ctx.repo.createTask({ title: "Undo me", priority: 3, energy: "light", estimateMin: 90 });
    const entry = ctx.svc.intervene("defer", filler.id, "test", "test", now())!;
    expect(ctx.repo.getTask(filler.id)!.snoozedUntil).toBeTruthy();
    const stored = ctx.repo.getLedger(entry.id)!;
    expect(stored.undo[0]!.patch).toHaveProperty("snoozedUntil", null);
    const undone = await call("POST", `/api/ledger/${entry.id}/undo`);
    expect(undone.status).toBe(200);
    expect(ctx.repo.getTask(filler.id)!.snoozedUntil).toBeUndefined();
  });
  it("completing a recurring task attributes focus minutes to the original id and clears its placement", async () => {
    const rec = ctx.repo.createTask({ title: "Daily journal", energy: "light", estimateMin: 15, recurrence: { freq: "daily", time: "08:00" }, plannedStart: now().toISOString(), plannedEnd: now().toISOString() });
    const f = ctx.repo.startFocus({ taskId: rec.id, title: rec.title, minutes: 20 });
    ctx.repo.endFocus(f.id, "completed");
    const r = await call("POST", "/api/agent/sync", { message: "done with daily journal" });
    expect(r.body.text).toMatch(/Done/);
    const out = ctx.repo.listOutcomes().find((o) => o.taskId === rec.id)!;
    expect(out.actualMin).toBe(20);
    const rolled = ctx.repo.getTask(rec.id)!;
    expect(rolled.status).toBe("open");
    expect(rolled.plannedStart).toBeUndefined();
  });
  it("an undecryptable stored key is reported, not used", async () => {
    ctx.repo.setMeta("anthropic_api_key", "enc:v1:AAAA:BBBB:CCCC");
    const p = (await call("GET", "/api/prefs")).body;
    expect(p.hasApiKey).toBe(false);
    expect(p.apiKeyError).toMatch(/decrypt/);
    expect(ctx.agent.mode()).toBe("local");
    ctx.repo.db.prepare("DELETE FROM meta WHERE key = 'anthropic_api_key'").run();
  });
  it("import sanitizes records instead of trusting them", async () => {
    const before = ctx.repo.listTasks({ status: "all" }).length;
    const r = await call("POST", "/api/import", { version: 1, tasks: [{ id: "tsk_ok1", title: "Imported fine", energy: "deep", estimateMin: 45 }, { id: "tsk_bad", title: "Bad", energy: "bogus" }, { id: "tsk_bad2", title: 42 }, "garbage"], memories: [{ id: "mem_ok", text: "Likes tea", kind: "preference", confidence: 7 }] });
    expect(r.status).toBe(200);
    const after = ctx.repo.listTasks({ status: "all" });
    expect(after.length).toBe(before + 1);
    expect(after.find((x) => x.id === "tsk_ok1")).toBeTruthy();
    expect(ctx.repo.getMemory("mem_ok")).toBeUndefined(); // confidence out of range → dropped
    const s = sanitizeImport({ events: [{ title: "x", start: "2026-09-03T10:00:00Z", end: "2026-09-03T09:00:00Z" }] });
    expect((s.events as unknown[]).length).toBe(0);
  });
  it("demo seed places events at local wall-clock time in any zone", () => {
    const fresh = createApp({ now, webDir: "/nonexistent", log: false });
    fresh.repo.setPrefs({ timezone: "Asia/Tokyo" });
    seedDemo(fresh.repo, now());
    const standup = fresh.repo.listEvents().find((e) => e.title === "Team standup")!;
    const local = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "numeric", minute: "2-digit", hourCycle: "h23" }).format(new Date(standup.start));
    expect(local).toBe("09:30");
  });
});
