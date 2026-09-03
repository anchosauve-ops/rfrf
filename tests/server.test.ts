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
    await app2.app.request("/api/prefs", { method: "PUT", body: JSON.stringify({ apiKey: "sk-ant-test" }), headers: { "content-type": "application/json" } });
    expect(app2.agent.mode()).toBe("claude");
  });
});
