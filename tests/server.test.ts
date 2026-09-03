import { describe, it, expect, beforeAll } from "vitest";
import { createApp, seedDemo } from "../src/server/app";

const now = () => new Date("2026-09-03T12:30:00Z");
type App = ReturnType<typeof createApp>;
let ctx: App;
const call = async (method: string, path: string, body?: unknown) => {
  const res = await ctx.app.request(path, { method, body: body ? JSON.stringify(body) : undefined, headers: { "content-type": "application/json" } });
  const text = await res.text();
  let json: unknown = undefined;
  try { json = JSON.parse(text); } catch { /* sse or empty */ }
  return { status: res.status, body: json as never, text };
};

beforeAll(() => {
  ctx = createApp({ now, webDir: "/nonexistent", apiKey: () => undefined });
  ctx.repo.setPrefs({ timezone: "America/New_York", name: "Will", onboarded: true });
  seedDemo(ctx.repo, now());
});

describe("server", () => {
  it("health reports local mode without a key", async () => {
    const r = await call("GET", "/api/health");
    expect(r.body).toMatchObject({ ok: true, mode: "local" });
  });
  it("creates tasks through the REST surface with natural language time", async () => {
    const r = await call("POST", "/api/tasks", { title: "Send deck", due: "friday 3pm", estimate_min: 20 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ title: "Send deck", due: "2026-09-04T19:00:00.000Z", estimateMin: 20 });
  });
  it("agent sync turn: plan, list, complete", async () => {
    const plan = await call("POST", "/api/agent/sync", { message: "plan my day" });
    expect(plan.body.cards[0].type).toBe("plan");
    expect(plan.body.cards[0].plan.blocks.length).toBeGreaterThan(3);
    const over = await call("POST", "/api/agent/sync", { message: "what's overdue" });
    expect(over.body.cards[0].tasks.map((t: { title: string }) => t.title)).toContain("Pay contractor invoice");
    const done = await call("POST", "/api/agent/sync", { message: "done with pay contractor invoice" });
    expect(done.body.text).toMatch(/Done: Pay contractor invoice/);
    const over2 = await call("POST", "/api/agent/sync", { message: "what's overdue" });
    expect(over2.body.text).toMatch(/nothing/i);
  });
  it("agent SSE stream emits start/card/done events", async () => {
    const r = await call("POST", "/api/agent", { message: "what's on today" });
    expect(r.status).toBe(200);
    expect(r.text).toContain("event: start");
    expect(r.text).toContain("event: card");
    expect(r.text).toContain("event: done");
  });
  it("memory round trip with provenance", async () => {
    await call("POST", "/api/agent/sync", { message: "remember that I hate meetings before 10am" });
    const mems = await call("GET", "/api/memories?q=meetings");
    expect(mems.body[0]).toMatchObject({ kind: "preference", source: "stated" });
    expect(mems.body[0].evidence).toContain("remember that I hate meetings");
    const hist = await call("GET", "/api/agent/history");
    expect(hist.body.length).toBeGreaterThan(2);
  });
  it("people: create, touch, staleness", async () => {
    await call("POST", "/api/agent/sync", { message: "met Jordan, colleague, every 2 weeks" });
    const people = await call("GET", "/api/people");
    const j = people.body.find((p: { name: string }) => p.name === "Jordan");
    expect(j).toMatchObject({ relation: "colleague", cadenceDays: 14 });
    await call("POST", "/api/agent/sync", { message: "talked to Jordan" });
    const after = await call("GET", "/api/people");
    expect(after.body.find((p: { name: string }) => p.name === "Jordan").lastContactAt).toBe(now().toISOString());
  });
  it("scheduler fires the morning ritual and watchers, producing nudges", () => {
    const fired = ctx.scheduler.tick();
    expect(fired.rituals).toContain("rit_morning");
    const nudges = ctx.repo.listNudges();
    expect(nudges.some((n) => n.origin === "rit_morning" && n.cards?.[0]?.type === "brief")).toBe(true);
    expect(nudges.some((n) => n.origin === "wat_people")).toBe(true);
    // second tick within cooldown: no duplicates
    const again = ctx.scheduler.tick();
    expect(again.rituals).not.toContain("rit_morning");
    expect(again.watchers).not.toContain("wat_people");
  });
  it("export → import into a fresh app is idempotent", async () => {
    const exp = await call("GET", "/api/export");
    const fresh = createApp({ now, webDir: "/nonexistent" });
    const res = await fresh.app.request("/api/import", { method: "POST", body: JSON.stringify(exp.body), headers: { "content-type": "application/json" } });
    const r = (await res.json()) as { imported: Record<string, number> };
    expect(r.imported.tasks).toBe(exp.body.tasks.length);
    const res2 = await fresh.app.request("/api/import", { method: "POST", body: JSON.stringify(exp.body), headers: { "content-type": "application/json" } });
    const r2 = (await res2.json()) as { imported: Record<string, number> };
    expect(r2.imported.tasks ?? 0).toBe(0);
  });
  it("prefs: api key stored in settings flips mode to claude", async () => {
    const before = await call("GET", "/api/prefs");
    expect(before.body.hasApiKey).toBe(false);
    const app2 = createApp({ now, webDir: "/nonexistent" });
    await app2.app.request("/api/prefs", { method: "PUT", body: JSON.stringify({ apiKey: "sk-ant-api03-" + "t".repeat(40) }), headers: { "content-type": "application/json" } });
    expect(app2.agent.mode()).toBe("claude");
  });
});

describe("symbiosis", () => {
  const now = () => new Date("2026-09-03T12:30:00Z");
  const ctx = createApp({ now, webDir: "/nonexistent" });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await ctx.app.request(path, { method, body: body ? JSON.stringify(body) : undefined, headers: { "content-type": "application/json" } });
    return { status: res.status, body: await res.json() };
  };
  beforeAll(() => {
    ctx.repo.setPrefs({ timezone: "America/New_York", name: "Will", onboarded: true, autonomy: "guardian" });
    seedDemo(ctx.repo, now());
  });

  it("goals: create via NL, list with alignment, link tasks, delete", async () => {
    const r = await call("POST", "/api/agent/sync", { message: "goal: learn Spanish by next June" });
    expect(r.body.cards[0].type).toBe("goals");
    const goals = (await call("GET", "/api/goals")).body;
    const g = goals.find((x: { title: string }) => /Spanish/.test(x.title));
    expect(g).toBeTruthy();
    expect(g.horizon).toBe("year");
    const link = await call("POST", "/api/agent/sync", { message: "remind me to book a Spanish tutor tomorrow" });
    expect(link.status).toBe(200);
    const task = ctx.repo.findTask("Spanish tutor")!;
    ctx.repo.updateTask(task.id, { goalId: g.id });
    const after = (await call("GET", "/api/goals")).body.find((x: { id: string }) => x.id === g.id);
    expect(after.alignment.openTasks).toBe(1);
    expect((await call("DELETE", `/api/goals/${g.id}`)).status).toBe(200);
    expect(ctx.repo.getTask(task.id)!.goalId).toBeUndefined();
  });

  it("mirror reflects seeded history and completing a task records an outcome", async () => {
    const m = (await call("GET", "/api/mirror")).body;
    expect(m.calibration.sampleSize).toBeGreaterThanOrEqual(18);
    expect(m.calibration.estimateBias.deep.factor).toBeGreaterThan(1.3);
    expect(m.learned.some((l: string) => /underestimate deep work/.test(l))).toBe(true);
    const before = ctx.repo.listOutcomes().length;
    const done = await call("POST", "/api/agent/sync", { message: "done with inbox to zero" });
    expect(done.body.text).toMatch(/Done/);
    expect(ctx.repo.listOutcomes().length).toBe(before + 1);
  });

  it("futures returns risks, interventions and per-day load", async () => {
    const f = (await call("GET", "/api/futures?days=5")).body;
    expect(f.horizonDays).toBe(5);
    expect(f.loadByDay.length).toBe(5);
    expect(f.risks.length).toBeGreaterThan(0);
    expect(f.capacity.availableMin).toBeGreaterThan(0);
    for (const r of f.risks) expect(r.pMiss).toBeGreaterThanOrEqual(0);
  });

  it("council (local) returns ordered findings with a decision", async () => {
    const c = (await call("POST", "/api/council", { question: "what should I cut?" })).body;
    expect(c.mode).toBe("local");
    expect(c.question).toBe("what should I cut?");
    expect(c.findings.length).toBeGreaterThan(0);
    expect(c.decision.length).toBeGreaterThan(0);
    const sev = c.findings.map((f: { severity: string }) => f.severity);
    const rank: Record<string, number> = { critical: 0, warn: 1, note: 2 };
    for (let i = 1; i < sev.length; i++) expect(rank[sev[i]!]).toBeGreaterThanOrEqual(rank[sev[i - 1]!]!);
  });

  it("guardian intervenes on high risk, logs to ledger, and undo restores", async () => {
    // Manufacture certain danger: a critical 20h task due tomorrow plus a low-priority filler to defer.
    ctx.repo.createTask({ title: "Impossible deliverable", priority: 1, energy: "deep", estimateMin: 20 * 60, due: new Date(now().getTime() + 26 * 3600_000).toISOString() });
    const filler = ctx.repo.createTask({ title: "Nice to have polish", priority: 3, energy: "light", estimateMin: 120 });
    const w = ctx.repo.listWatchers().find((x) => x.kind === "deadline_risk")!;
    ctx.repo.upsertWatcher({ ...w, lastFiredAt: undefined });
    const fired = ctx.scheduler.tick();
    expect(fired.watchers).toContain(w.id);
    const ledger = (await call("GET", "/api/ledger")).body;
    expect(ledger.length).toBeGreaterThan(0);
    const entry = ledger[0];
    expect(["defer_task", "shrink_estimate"]).toContain(entry.action);
    const nudges = (await call("GET", "/api/nudges")).body;
    expect(nudges.some((n: { title: string }) => /Guardian acted/.test(n.title))).toBe(true);
    const undone = await call("POST", `/api/ledger/${entry.id}/undo`);
    expect(undone.status).toBe(200);
    expect(undone.body.undoneAt).toBeTruthy();
    if (entry.action === "defer_task" && entry.undo[0].id === filler.id) expect(ctx.repo.getTask(filler.id)!.snoozedUntil).toBeUndefined();
    const again = await call("POST", `/api/ledger/${entry.id}/undo`);
    expect(again.status).toBe(404);
  });

  it("reflection ritual writes learned insights into memory without duplicating", async () => {
    const r = ctx.repo.listRituals().find((x) => x.kind === "reflection")!;
    ctx.scheduler.runRitual(r, now());
    const learned = ctx.repo.listMemories().filter((m) => m.tags.includes("learned"));
    expect(learned.length).toBeGreaterThan(0);
    ctx.scheduler.runRitual(r, now());
    expect(ctx.repo.listMemories().filter((m) => m.tags.includes("learned")).length).toBe(learned.length);
  });

  it("export includes goals, outcomes and ledger", async () => {
    const e = (await call("GET", "/api/export")).body;
    expect(Array.isArray(e.goals)).toBe(true);
    expect(e.outcomes.length).toBeGreaterThan(10);
    expect(Array.isArray(e.ledger)).toBe(true);
  });
});
