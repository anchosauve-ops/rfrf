import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "./db.js";
import { Repo } from "./repo.js";
import { Services } from "./services.js";
import { Agent } from "./agent/index.js";
import { Scheduler } from "./scheduler.js";
import { Bus } from "./bus.js";
import { dayKey, parseChrono, type Preferences } from "../core/index.js";

export interface AppOptions {
  dbPath?: string;
  webDir?: string;
  now?: () => Date;
  apiKey?: () => string | undefined;
}

export function createApp(opts: AppOptions = {}) {
  const db = openDb(opts.dbPath ?? ":memory:");
  const repo = new Repo(db);
  repo.ensureDefaults();
  const svc = new Services(repo);
  const bus = new Bus();
  const agent = new Agent({ svc, now: opts.now, apiKey: opts.apiKey });
  const scheduler = new Scheduler(svc, bus, opts.now ?? (() => new Date()));
  const now = () => opts.now?.() ?? new Date();

  const app = new Hono();
  app.use("/api/*", cors());
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: err.message }, 500);
  });

  const json = async <T>(c: { req: { json: () => Promise<unknown> } }): Promise<T> => {
    try {
      return (await c.req.json()) as T;
    } catch {
      return {} as T;
    }
  };
  const notify = (entity: string) => bus.publish({ type: "mutation", entity });

  // ---------- health & context ----------
  app.get("/api/health", (c) => c.json({ ok: true, mode: agent.mode(), now: now().toISOString() }));
  app.get("/api/context", (c) => {
    const prefs = repo.getPrefs();
    const open = repo.listTasks({ status: "open" });
    const t = now();
    return c.json({
      now: t.toISOString(),
      mode: agent.mode(),
      prefs,
      counts: {
        openTasks: open.length,
        overdue: svc.overdueTasks(t).length,
        todayEvents: svc.todaysEvents(t).length,
        memories: repo.listMemories().length,
        people: repo.listPeople().length,
        unreadNudges: repo.listNudges().filter((n) => !n.readAt).length,
      },
      plan: repo.getPlan(dayKey(t, prefs.timezone)) ?? null,
    });
  });

  // ---------- prefs ----------
  app.get("/api/prefs", (c) => c.json({ ...repo.getPrefs(), hasApiKey: !!agent.apiKey(), apiKeySource: process.env.ANTHROPIC_API_KEY ? "env" : repo.getMeta("anthropic_api_key") ? "settings" : null }));
  app.put("/api/prefs", async (c) => {
    const body = await json<Partial<Preferences> & { apiKey?: string | null }>(c);
    const { apiKey, ...patch } = body;
    if (apiKey !== undefined) {
      if (apiKey) repo.setMeta("anthropic_api_key", apiKey.trim());
      else db.prepare("DELETE FROM meta WHERE key = 'anthropic_api_key'").run();
    }
    const prefs = repo.setPrefs(patch);
    notify("prefs");
    return c.json({ ...prefs, hasApiKey: !!agent.apiKey() });
  });

  // ---------- tasks ----------
  app.get("/api/tasks", (c) => c.json(repo.listTasks({ status: (c.req.query("status") as never) ?? "open" })));
  app.post("/api/tasks", async (c) => {
    const body = await json<Record<string, unknown>>(c);
    const r = agent.tools.create_task!.run(body, now());
    if (r.ok === false) return c.json({ error: r.text }, 400);
    notify("task");
    return c.json(r.cards?.[0]?.type === "tasks" ? r.cards[0].tasks[0] : null, 201);
  });
  app.patch("/api/tasks/:id", async (c) => {
    const body = await json<Record<string, unknown>>(c);
    const t = repo.updateTask(c.req.param("id"), body as never);
    if (!t) return c.json({ error: "not found" }, 404);
    notify("task");
    return c.json(t);
  });
  app.post("/api/tasks/:id/complete", (c) => {
    const r = agent.tools.complete_task!.run({ id: c.req.param("id") }, now());
    if (r.ok === false) return c.json({ error: r.text }, 404);
    notify("task");
    return c.json({ ok: true, text: r.text });
  });
  app.delete("/api/tasks/:id", (c) => {
    if (!repo.deleteTask(c.req.param("id"))) return c.json({ error: "not found" }, 404);
    notify("task");
    return c.json({ ok: true });
  });

  // ---------- events ----------
  app.get("/api/events", (c) => {
    const from = c.req.query("from");
    const to = c.req.query("to");
    return c.json(from && to ? repo.listEvents({ from, to }) : repo.listEvents());
  });
  app.post("/api/events", async (c) => {
    const body = await json<Record<string, unknown>>(c);
    const r = agent.tools.create_event!.run(body, now());
    if (r.ok === false) return c.json({ error: r.text }, 400);
    notify("event");
    return c.json(r.cards?.[0]?.type === "events" ? r.cards[0].events[0] : null, 201);
  });
  app.patch("/api/events/:id", async (c) => {
    const e = repo.updateEvent(c.req.param("id"), (await json<Record<string, unknown>>(c)) as never);
    if (!e) return c.json({ error: "not found" }, 404);
    notify("event");
    return c.json(e);
  });
  app.delete("/api/events/:id", (c) => {
    if (!repo.deleteEvent(c.req.param("id"))) return c.json({ error: "not found" }, 404);
    notify("event");
    return c.json({ ok: true });
  });

  // ---------- memories ----------
  app.get("/api/memories", (c) => {
    const q = c.req.query("q");
    if (q) {
      const r = agent.tools.recall!.run({ query: q, limit: 30 }, now());
      return c.json(r.cards?.[0]?.type === "memories" ? r.cards[0].memories : []);
    }
    return c.json(repo.listMemories());
  });
  app.post("/api/memories", async (c) => {
    const r = agent.tools.remember!.run(await json<Record<string, unknown>>(c), now());
    if (r.ok === false) return c.json({ error: r.text }, 400);
    notify("memory");
    return c.json(r.cards?.[0]?.type === "memories" ? r.cards[0].memories[0] : null, 201);
  });
  app.patch("/api/memories/:id", async (c) => {
    const m = repo.updateMemory(c.req.param("id"), (await json<Record<string, unknown>>(c)) as never);
    if (!m) return c.json({ error: "not found" }, 404);
    notify("memory");
    return c.json(m);
  });
  app.delete("/api/memories/:id", (c) => {
    if (!repo.deleteMemory(c.req.param("id"))) return c.json({ error: "not found" }, 404);
    notify("memory");
    return c.json({ ok: true });
  });

  // ---------- people ----------
  app.get("/api/people", (c) => {
    const t = now();
    const stale = new Map(svc.stalePeople(t, 0).map((s) => [s.person.id, s]));
    return c.json(repo.listPeople().map((p) => ({ ...p, staleness: stale.get(p.id)?.ratio ?? 0 })));
  });
  app.post("/api/people", async (c) => {
    const r = agent.tools.upsert_person!.run(await json<Record<string, unknown>>(c), now());
    if (r.ok === false) return c.json({ error: r.text }, 400);
    notify("person");
    return c.json(r.cards?.[0]?.type === "people" ? r.cards[0].people[0] : null, 201);
  });
  app.patch("/api/people/:id", async (c) => {
    const p = repo.updatePerson(c.req.param("id"), (await json<Record<string, unknown>>(c)) as never);
    if (!p) return c.json({ error: "not found" }, 404);
    notify("person");
    return c.json(p);
  });
  app.post("/api/people/:id/touch", (c) => {
    const p = repo.updatePerson(c.req.param("id"), { lastContactAt: now().toISOString() });
    if (!p) return c.json({ error: "not found" }, 404);
    notify("person");
    return c.json(p);
  });
  app.delete("/api/people/:id", (c) => {
    if (!repo.deletePerson(c.req.param("id"))) return c.json({ error: "not found" }, 404);
    notify("person");
    return c.json({ ok: true });
  });

  // ---------- rituals & watchers & nudges ----------
  app.get("/api/rituals", (c) => c.json(repo.listRituals()));
  app.put("/api/rituals/:id", async (c) => {
    const cur = repo.listRituals().find((r) => r.id === c.req.param("id"));
    if (!cur) return c.json({ error: "not found" }, 404);
    const patch = await json<Record<string, unknown>>(c);
    return c.json(repo.upsertRitual({ ...cur, ...(patch as Partial<typeof cur>) }));
  });
  app.post("/api/rituals/:id/run", (c) => {
    const r = repo.listRituals().find((x) => x.id === c.req.param("id"));
    if (!r) return c.json({ error: "not found" }, 404);
    return c.json(scheduler.runRitual(r, now()));
  });
  app.get("/api/watchers", (c) => c.json(repo.listWatchers()));
  app.put("/api/watchers/:id", async (c) => {
    const cur = repo.listWatchers().find((w) => w.id === c.req.param("id"));
    if (!cur) return c.json({ error: "not found" }, 404);
    return c.json(repo.upsertWatcher({ ...cur, ...((await json<Record<string, unknown>>(c)) as Partial<typeof cur>) }));
  });
  app.post("/api/scheduler/tick", (c) => c.json(scheduler.tick()));
  app.get("/api/nudges", (c) => c.json(repo.listNudges({ includeDismissed: c.req.query("all") === "1" })));
  app.post("/api/nudges/:id/read", (c) => {
    repo.markNudge(c.req.param("id"), "read");
    return c.json({ ok: true });
  });
  app.post("/api/nudges/:id/dismiss", (c) => {
    repo.markNudge(c.req.param("id"), "dismissed");
    notify("nudge");
    return c.json({ ok: true });
  });

  // ---------- plan & brief ----------
  app.get("/api/plan", (c) => {
    const t = now();
    const date = c.req.query("date") ?? dayKey(t, repo.getPrefs().timezone);
    return c.json(svc.planFor(date, t));
  });
  app.post("/api/plan", async (c) => {
    const body = await json<{ date?: string }>(c);
    const t = now();
    const plan = svc.plan(body.date ?? dayKey(t, repo.getPrefs().timezone), t);
    notify("plan");
    return c.json(plan);
  });
  app.get("/api/brief", (c) => c.json(svc.brief((c.req.query("kind") as never) ?? "morning", now())));
  app.get("/api/parse", (c) => {
    const text = c.req.query("text") ?? "";
    const prefs = repo.getPrefs();
    const r = parseChrono(text, { now: now(), tz: prefs.timezone, endOfDayMin: prefs.workdayEndMin });
    return c.json({ ...r, start: r.start?.toISOString(), end: r.end?.toISOString() });
  });

  // ---------- focus ----------
  app.post("/api/focus/start", async (c) => {
    const body = await json<{ minutes?: number; taskId?: string; title?: string }>(c);
    const t = body.taskId ? repo.getTask(body.taskId) : undefined;
    const s = repo.startFocus({ taskId: t?.id, title: body.title ?? t?.title ?? "Focus", minutes: body.minutes ?? 25 });
    bus.publish({ type: "focus", state: "started" });
    return c.json(s, 201);
  });
  app.post("/api/focus/:id/end", async (c) => {
    const body = await json<{ outcome?: string }>(c);
    repo.endFocus(c.req.param("id"), body.outcome ?? "completed");
    bus.publish({ type: "focus", state: "ended" });
    return c.json({ ok: true, focusMinToday: repo.focusMinutesSince(new Date(now().getTime() - 86400_000).toISOString()) });
  });

  // ---------- agent ----------
  app.get("/api/agent/history", (c) => c.json(repo.listTurns(c.req.query("conversationId") ?? "main", Number(c.req.query("limit") ?? 60))));
  app.delete("/api/agent/history", (c) => {
    repo.clearConversation(c.req.query("conversationId") ?? "main");
    return c.json({ ok: true });
  });
  app.post("/api/agent", async (c) => {
    const body = await json<{ message?: string; conversationId?: string }>(c);
    const message = (body.message ?? "").trim();
    if (!message) return c.json({ error: "message required" }, 400);
    const conversationId = body.conversationId ?? "main";
    return streamSSE(c, async (stream) => {
      let id = 0;
      for await (const ev of agent.run(message, conversationId)) {
        await stream.writeSSE({ id: String(id++), event: ev.type, data: JSON.stringify(ev) });
        if (ev.type === "mutation") notify(ev.entity);
      }
    });
  });
  /** Non-streaming variant for scripts, tests and voice assistants. */
  app.post("/api/agent/sync", async (c) => {
    const body = await json<{ message?: string; conversationId?: string }>(c);
    const message = (body.message ?? "").trim();
    if (!message) return c.json({ error: "message required" }, 400);
    let done: { text: string; cards: unknown[] } = { text: "", cards: [] };
    const events: unknown[] = [];
    for await (const ev of agent.run(message, body.conversationId ?? "main")) {
      events.push(ev);
      if (ev.type === "done") done = { text: ev.text, cards: ev.cards };
      if (ev.type === "mutation") notify(ev.entity);
    }
    return c.json({ ...done, events });
  });

  // ---------- live stream ----------
  app.get("/api/stream", (c) =>
    streamSSE(c, async (stream) => {
      let id = 0;
      await stream.writeSSE({ id: String(id++), event: "hello", data: JSON.stringify({ mode: agent.mode(), now: now().toISOString() }) });
      const unsub = bus.subscribe((e) => {
        void stream.writeSSE({ id: String(id++), event: e.type, data: JSON.stringify(e) });
      });
      const ping = setInterval(() => void stream.writeSSE({ event: "ping", data: "{}" }), 25_000);
      stream.onAbort(() => {
        unsub();
        clearInterval(ping);
      });
      await new Promise<void>((resolve) => stream.onAbort(resolve));
    }),
  );

  // ---------- export / import ----------
  app.get("/api/export", (c) => {
    c.header("Content-Disposition", `attachment; filename="kairos-${dayKey(now(), repo.getPrefs().timezone)}.json"`);
    return c.json(repo.exportAll());
  });
  app.post("/api/import", async (c) => {
    const data = await json<Record<string, unknown>>(c);
    const r = repo.importAll(data);
    notify("task"); notify("event"); notify("memory"); notify("person");
    return c.json(r);
  });
  app.post("/api/demo", (c) => {
    seedDemo(repo, now());
    notify("task"); notify("event"); notify("memory"); notify("person");
    return c.json({ ok: true });
  });

  // ---------- static web app ----------
  const webDir = opts.webDir ?? join(process.cwd(), "dist", "web");
  if (existsSync(webDir)) {
    app.use("/*", serveStatic({ root: webDir.replace(process.cwd() + "/", "") }));
    app.get("*", (c) => {
      if (c.req.path.startsWith("/api/")) return c.json({ error: "not found" }, 404);
      return c.html(readFileSync(join(webDir, "index.html"), "utf8"));
    });
  }

  return { app, repo, svc, agent, scheduler, bus, db };
}

/** A believable first day, so the product is legible in 10 seconds. */
export function seedDemo(repo: Repo, now: Date): void {
  const prefs = repo.getPrefs();
  if (!prefs.name) repo.setPrefs({ name: "Will" });
  const d = (h: number, m = 0, dayOffset = 0) => {
    const t = new Date(now);
    t.setUTCDate(t.getUTCDate() + dayOffset);
    t.setUTCHours(h, m, 0, 0);
    return t.toISOString();
  };
  const tz = repo.getPrefs().timezone;
  const localHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(now));
  const offset = now.getUTCHours() - localHour; // approx UTC offset in hours
  const L = (h: number, m = 0, dayOffset = 0) => d((h + offset + 24) % 24, m, dayOffset + (h + offset >= 24 ? 1 : 0));

  const priya = repo.findPerson("Priya") ?? repo.createPerson({ name: "Priya", relation: "colleague", cadenceDays: 14, notes: "Design lead. Loves systems thinking.", lastContactAt: new Date(now.getTime() - 20 * 86400_000).toISOString() });
  const sam = repo.findPerson("Sam") ?? repo.createPerson({ name: "Sam", relation: "mentor", cadenceDays: 30, lastContactAt: new Date(now.getTime() - 45 * 86400_000).toISOString() });
  repo.findPerson("Dana") ?? repo.createPerson({ name: "Dana", relation: "friend", cadenceDays: 21, lastContactAt: new Date(now.getTime() - 3 * 86400_000).toISOString() });
  repo.findPerson("Mom") ?? repo.createPerson({ name: "Mom", relation: "mother", cadenceDays: 7, lastContactAt: new Date(now.getTime() - 9 * 86400_000).toISOString() });

  if (repo.listTasks({ status: "all" }).length === 0) {
    repo.createTask({ title: "Write investor update", energy: "deep", estimateMin: 120, priority: 2, due: L(17, 0, 0), notes: "Q3 numbers, hiring plan, the honest section about churn." });
    repo.createTask({ title: "Pay contractor invoice", energy: "admin", estimateMin: 15, priority: 2, due: L(17, 0, -1) });
    repo.createTask({ title: "Review Priya's design doc", energy: "light", estimateMin: 45, priority: 3, peopleIds: [priya.id], due: L(12, 0, 1) });
    repo.createTask({ title: "Call Mom", energy: "social", estimateMin: 30, priority: 3, pinnedStart: L(18, 0, 0) });
    repo.createTask({ title: "Read the systems paper Sam sent", energy: "deep", estimateMin: 60, priority: 4, peopleIds: [sam.id] });
    repo.createTask({ title: "Renew passport", energy: "admin", estimateMin: 40, priority: 3, due: L(17, 0, 6) });
    repo.createTask({ title: "Plan offsite agenda", energy: "deep", estimateMin: 90, priority: 2, due: L(17, 0, 2) });
    repo.createTask({ title: "Inbox to zero", energy: "admin", estimateMin: 30, priority: 3 });
    repo.createTask({ title: "Book flights for October", energy: "admin", estimateMin: 25, priority: 3, due: L(17, 0, 4) });
    repo.createTask({ title: "Sketch onboarding flow", energy: "deep", estimateMin: 75, priority: 3 });
    const done = repo.createTask({ title: "Send offer letter", energy: "admin", estimateMin: 20, priority: 1 });
    repo.updateTask(done.id, { status: "done", completedAt: new Date(now.getTime() - 3 * 3600_000).toISOString() });
  }
  if (repo.listEvents().length === 0) {
    repo.createEvent({ title: "Team standup", start: L(9, 30), end: L(9, 45), kind: "meeting" });
    repo.createEvent({ title: "Lunch with Dana", start: L(12, 30), end: L(13, 30), kind: "personal", location: "Blue Bottle" });
    repo.createEvent({ title: "Design review", start: L(15, 0), end: L(16, 0), kind: "meeting", peopleIds: [priya.id] });
    repo.createEvent({ title: "1:1 with Sam", start: L(10, 0, 1), end: L(10, 45, 1), kind: "meeting", peopleIds: [sam.id] });
    repo.createEvent({ title: "Dentist", start: L(8, 30, 3), end: L(9, 30, 3), kind: "personal" });
  }
  if (repo.listMemories().length === 0) {
    repo.createMemory({ text: "Ship Kairos v1 by the end of October", kind: "goal", importance: 0.95, confidence: 0.95, source: "stated", pinned: true, evidence: "\"The whole point of this quarter is shipping v1 by Halloween.\"" });
    repo.createMemory({ text: "Prefers deep work before noon; afternoons are for people", kind: "preference", importance: 0.85, confidence: 0.9, source: "stated", evidence: "\"Don't book me before noon if you can help it.\"" });
    repo.createMemory({ text: "Tends to underestimate writing tasks by about 2x", kind: "insight", importance: 0.7, confidence: 0.65, source: "inferred", evidence: "Last three writing tasks ran 90–140 min against 45-min estimates." });
    repo.createMemory({ text: "Mom's birthday is October 14", kind: "relationship", importance: 0.8, confidence: 0.95, source: "stated" });
    repo.createMemory({ text: "Drinks too much coffee after 3pm and sleeps badly when they do", kind: "insight", importance: 0.5, confidence: 0.55, source: "inferred", evidence: "Mentioned poor sleep twice after late-afternoon coffee meetings." });
    repo.createMemory({ text: "Works at a 12-person startup building developer tools", kind: "fact", importance: 0.6, confidence: 0.9, source: "stated" });
  }
}
