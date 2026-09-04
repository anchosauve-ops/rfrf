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
import { dayKey, parseChrono, describeCalibration, setTime, addDays, startOfDay, type Preferences } from "../core/index.js";
import { ValidationError, taskPatch, eventPatch, memoryPatch, personPatch, goalPatch, ritualPatch, watcherPatch, prefsPatch, worklogImport } from "./validate.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { secretKey, seal, open as unseal } from "./secrets.js";
import { writeBackup, backupDir, lastBackupAt } from "./backup.js";

export interface AppOptions {
  dbPath?: string;
  webDir?: string;
  now?: () => Date;
  apiKey?: () => string | undefined;
  /** log requests to stdout (default: true outside tests) */
  log?: boolean;
  /** max request body in bytes (default 2 MB; import allows 25 MB) */
  maxBody?: number;
  backupDir?: string;
}

const START = Date.now();
const MAX_BODY = 2 * 1024 * 1024;
const MAX_IMPORT = 25 * 1024 * 1024;

export function createApp(opts: AppOptions = {}) {
  const dbPath = opts.dbPath ?? ":memory:";
  const db = openDb(dbPath);
  const repo = new Repo(db);
  repo.ensureDefaults();
  const svc = new Services(repo);
  const bus = new Bus();
  const key = secretKey(dbPath);
  const storedApiKey = () => {
    const raw = repo.getMeta("anthropic_api_key");
    if (!raw) return undefined;
    const plain = unseal(raw, key);
    if (plain && raw === plain) repo.setMeta("anthropic_api_key", seal(plain, key)); // upgrade legacy plaintext
    return plain || undefined;
  };
  /** A stored key exists but can't be decrypted (secret rotated or lost). */
  const apiKeyUnreadable = () => {
    const raw = repo.getMeta("anthropic_api_key");
    return !!raw && raw.startsWith("enc:v1:") && !unseal(raw, key);
  };
  const agent = new Agent({ svc, now: opts.now, apiKey: opts.apiKey ?? (() => process.env.ANTHROPIC_API_KEY || storedApiKey()) });
  const scheduler = new Scheduler(svc, bus, opts.now ?? (() => new Date()));
  const now = () => opts.now?.() ?? new Date();

  const app = new Hono();
  // One install-scoped token lets the Timeproof bookmarklet push hours in from onlinejobs.ph.
  const importToken = () => {
    let t = repo.getMeta("import_token");
    if (!t) { t = randomBytes(18).toString("base64url"); repo.setMeta("import_token", t); }
    return t;
  };
  const tokenOk = (given: string | undefined) => {
    const want = Buffer.from(importToken());
    const got = Buffer.from(given ?? "");
    return got.length === want.length && timingSafeEqual(got, want);
  };
  // The import endpoint is the one route a foreign origin may call, and only with the token.
  app.use("/api/worklog/import", cors({ origin: (o) => o || "*", allowHeaders: ["content-type", "x-kairos-token"], allowMethods: ["POST", "OPTIONS"] }));
  // Local-first: only the app's own origin (and the Vite dev server) may call the API from a browser.
  app.use(
    "/api/*",
    cors({
      origin: (origin, c) => {
        if (!origin) return origin;
        if (c.req.path === "/api/worklog/import") return origin;
        const allowed = (process.env.KAIROS_ALLOWED_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173").split(",").map((o) => o.trim());
        if (allowed.includes(origin)) return origin;
        try {
          const u = new URL(origin);
          if (["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return origin;
        } catch { /* ignore */ }
        return "";
      },
    }),
  );
  app.onError((err, c) => {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    console.error(`[kairos] ${c.req.method} ${c.req.path} failed:`, err);
    return c.json({ error: "internal error" }, 500);
  });

  // request log + body limit
  const shouldLog = opts.log ?? process.env.NODE_ENV !== "test";
  app.use("/api/*", async (c, next) => {
    const len = Number(c.req.header("content-length") ?? 0);
    const limit = c.req.path === "/api/import" ? MAX_IMPORT : (opts.maxBody ?? MAX_BODY);
    if (len > limit) return c.json({ error: `request body too large (max ${Math.round(limit / 1024)} KB)` }, 413);
    const t0 = performance.now();
    await next();
    if (shouldLog && c.req.path !== "/api/stream") console.log(`[kairos] ${c.req.method} ${c.req.path} ${c.res.status} ${Math.round(performance.now() - t0)}ms`);
  });

  const json = async <T>(c: { req: { json: () => Promise<unknown>; header: (n: string) => string | undefined } }): Promise<T> => {
    try {
      const v = await c.req.json();
      if (v === null || typeof v !== "object") throw new ValidationError("body must be a JSON object");
      return v as T;
    } catch (e) {
      if (e instanceof ValidationError) throw e;
      return {} as T;
    }
  };
  const notify = (entity: string) => bus.publish({ type: "mutation", entity });

  // ---------- health & context ----------
  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      mode: agent.mode(),
      now: now().toISOString(),
      uptimeSec: Math.round((Date.now() - START) / 1000),
      db: dbPath === ":memory:" ? "memory" : "file",
      lastBackupAt: dbPath === ":memory:" && !opts.backupDir ? null : (lastBackupAt(backupDir(dbPath, opts.backupDir))?.toISOString() ?? null),
    }),
  );
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
        goals: repo.listGoals().length,
        outcomes: repo.listOutcomes(undefined, 5000).length,
      },
      plan: repo.getPlan(dayKey(t, prefs.timezone)) ?? null,
    });
  });

  // ---------- prefs ----------
  app.get("/api/prefs", (c) =>
    c.json({
      ...repo.getPrefs(),
      hasApiKey: !!agent.apiKey(),
      apiKeySource: process.env.ANTHROPIC_API_KEY ? "env" : agent.apiKey() ? "settings" : null,
      apiKeyError: apiKeyUnreadable() ? "The saved API key can't be decrypted (the local secret changed). Re-enter it." : null,
    }),
  );
  app.put("/api/prefs", async (c) => {
    const body = prefsPatch(await json<Record<string, unknown>>(c));
    const { apiKey, ...patch } = body;
    if (apiKey !== undefined) {
      if (apiKey) repo.setMeta("anthropic_api_key", seal(apiKey, key));
      else db.prepare("DELETE FROM meta WHERE key = 'anthropic_api_key'").run();
    }
    const prefs = repo.setPrefs(patch as Partial<Preferences>);
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
    const body = taskPatch(await json<Record<string, unknown>>(c));
    const cur = repo.getTask(c.req.param("id"));
    if (!cur) return c.json({ error: "not found" }, 404);
    const clears = Object.keys(body).filter((k) => k.startsWith("__clear_")) as `__clear_${"due" | "pinnedStart" | "snoozedUntil"}`[];
    for (const k of clears) { delete (body as Record<string, unknown>)[k]; (body as Record<string, unknown>)[k.replace("__clear_", "")] = undefined; }
    const t = repo.updateTask(cur.id, body);
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
    const e = repo.updateEvent(c.req.param("id"), eventPatch(await json<Record<string, unknown>>(c)));
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
    const m = repo.updateMemory(c.req.param("id"), memoryPatch(await json<Record<string, unknown>>(c)));
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
    const p = repo.updatePerson(c.req.param("id"), personPatch(await json<Record<string, unknown>>(c)));
    if (!p) return c.json({ error: "not found" }, 404);
    notify("person");
    return c.json(p);
  });
  // ---------- team: work logs & payroll ----------
  app.get("/api/team", (c) => c.json(svc.teamSummary(now())));
  app.get("/api/people/:id/worklog", (c) => {
    const p = repo.getPerson(c.req.param("id"));
    if (!p) return c.json({ error: "not found" }, 404);
    const from = c.req.query("from");
    const to = c.req.query("to");
    return c.json(repo.listWorklogs(p.id, from && to ? { from, to } : undefined));
  });
  app.get("/api/people/:id/payroll", (c) => {
    const p = repo.getPerson(c.req.param("id"));
    if (!p) return c.json({ error: "not found" }, 404);
    return c.json(svc.payroll(p, c.req.query("period") ?? undefined, now()));
  });
  app.delete("/api/worklog/:id", (c) => {
    if (!repo.deleteWorklog(c.req.param("id"))) return c.json({ error: "not found" }, 404);
    notify("worklog");
    return c.json({ ok: true });
  });
  app.get("/api/worklog/token", (c) => c.json({ token: importToken() }));
  app.post("/api/worklog/token/rotate", (c) => {
    repo.setMeta("import_token", randomBytes(18).toString("base64url"));
    return c.json({ token: importToken() });
  });
  /** Bookmarklet / paste target. Same-origin callers are trusted; foreign origins must present the token. */
  app.post("/api/worklog/import", async (c) => {
    const origin = c.req.header("origin");
    const foreign = !!origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin) && origin !== new URL(c.req.url).origin;
    if (foreign && !tokenOk(c.req.header("x-kairos-token"))) return c.json({ error: "bad or missing import token" }, 401);
    const body = worklogImport(await json<Record<string, unknown>>(c));
    let person = body.personId ? repo.getPerson(body.personId) : body.person ? repo.findPerson(body.person) : undefined;
    if (!person && body.person) person = repo.createPerson({ name: body.person, relation: "worker" });
    if (!person) {
      const paid = repo.listPeople().filter((p) => p.hourlyRate);
      if (paid.length === 1) person = paid[0];
    }
    if (!person) return c.json({ error: "say who these hours belong to (person or personId)" }, 400);
    const t = now();
    const result = body.days.length ? svc.importWorklog(person, body.days, body.source, t) : svc.importWorklogText(person, body.text!, body.source === "import" ? "paste" : body.source, t);
    notify("worklog");
    return c.json({ ok: true, person: { id: person.id, name: person.name, hourlyRate: person.hourlyRate ?? null }, ...result, payroll: person.hourlyRate ? svc.payroll(person, "this month", t) : null });
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
    const patch = ritualPatch(await json<Record<string, unknown>>(c));
    return c.json(repo.upsertRitual({ ...cur, ...patch, rule: patch.rule ? { ...cur.rule, ...patch.rule } : cur.rule }));
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
    return c.json(repo.upsertWatcher({ ...cur, ...watcherPatch(await json<Record<string, unknown>>(c)) }));
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

  // ---------- symbiosis: goals, futures, council, mirror, ledger ----------
  app.get("/api/goals", (c) => {
    const goals = repo.listGoals(c.req.query("all") === "1");
    const al = svc.goalAlignment(now());
    return c.json(goals.map((g) => ({ ...g, alignment: al.find((a) => a.goalId === g.id) ?? null })));
  });
  app.post("/api/goals", async (c) => {
    const r = agent.tools.create_goal!.run(await json<Record<string, unknown>>(c), now());
    if (r.ok === false) return c.json({ error: r.text }, 400);
    notify("goal");
    return c.json(r.cards?.[0]?.type === "goals" ? r.cards[0].goals[0] : null, 201);
  });
  app.patch("/api/goals/:id", async (c) => {
    const g = repo.updateGoal(c.req.param("id"), goalPatch(await json<Record<string, unknown>>(c)));
    if (!g) return c.json({ error: "not found" }, 404);
    notify("goal");
    return c.json(g);
  });
  app.delete("/api/goals/:id", (c) => {
    if (!repo.deleteGoal(c.req.param("id"))) return c.json({ error: "not found" }, 404);
    notify("goal"); notify("task");
    return c.json({ ok: true });
  });
  app.get("/api/futures", (c) => c.json(svc.futures(now(), Number(c.req.query("days") ?? 7))));
  app.post("/api/council", async (c) => {
    const body = await json<{ question?: string }>(c);
    return c.json(await agent.council(body.question));
  });
  app.get("/api/mirror", (c) => {
    const t = now();
    const cal = svc.calibration(t);
    return c.json({ calibration: cal, learned: describeCalibration(cal), outcomes: repo.listOutcomes(undefined, 200).length, prefs: repo.getPrefs(), ledger: repo.listLedger(30), alignment: svc.goalAlignment(t) });
  });
  app.post("/api/mirror/adopt-curve", (c) => {
    const cal = svc.calibration(now());
    if (!cal.proposedCurve) return c.json({ error: "not enough evidence yet" }, 400);
    const before = repo.getPrefs().energyCurve;
    repo.setPrefs({ energyCurve: cal.proposedCurve });
    const entry = repo.addLedger({ action: "tune_curve", summary: "Adopted the learned energy curve.", reason: `${cal.sampleSize} outcomes`, undo: [{ entity: "prefs", patch: { energyCurve: before } }], origin: "mirror" });
    notify("prefs"); notify("ledger");
    return c.json({ ok: true, entry, prefs: repo.getPrefs() });
  });
  app.get("/api/ledger", (c) => c.json(repo.listLedger(Number(c.req.query("limit") ?? 50))));
  app.post("/api/ledger/:id/undo", (c) => {
    const e = svc.undo(c.req.param("id"));
    if (!e) return c.json({ error: "nothing to undo" }, 404);
    notify("ledger"); notify("task"); notify("plan"); notify("prefs");
    return c.json(e);
  });
  app.post("/api/outcomes/backfill", (c) => {
    // For people who arrive with a history: turn already-done tasks into outcomes once.
    const have = new Set(repo.listOutcomes().map((o) => o.taskId));
    let n = 0;
    for (const t of repo.listTasks({ status: "done" })) {
      if (have.has(t.id) || !t.completedAt) continue;
      svc.recordOutcome(t, new Date(t.completedAt));
      n++;
    }
    return c.json({ backfilled: n });
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
    if (data.version !== undefined && data.version !== 1) return c.json({ error: `unsupported export version ${String(data.version)}` }, 400);
    const r = repo.importAll(sanitizeImport(data));
    notify("task"); notify("event"); notify("memory"); notify("person");
    return c.json(r);
  });
  app.post("/api/backup", (c) => {
    const path = writeBackup(repo, { dbPath, dir: opts.backupDir }, now());
    return c.json({ ok: !!path, path: path ?? null });
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

  const backup = () => writeBackup(repo, { dbPath, dir: opts.backupDir }, now());
  const close = () => {
    scheduler.stop();
    try { db.close(); } catch { /* already closed */ }
  };
  return { app, repo, svc, agent, scheduler, bus, db, backup, close };
}

/** Run every imported record through the same sanitizers as the API. Records that fail are dropped, not fatal. */
export function sanitizeImport(data: Record<string, unknown>): Record<string, unknown> {
  const clean = <T>(items: unknown, fn: (raw: Record<string, unknown>) => Partial<T>, required: (keyof T)[]): (Partial<T> & { id?: string })[] => {
    if (!Array.isArray(items)) return [];
    const out: (Partial<T> & { id?: string })[] = [];
    for (const it of items) {
      if (!it || typeof it !== "object") continue;
      try {
        const raw = it as Record<string, unknown>;
        const p = fn(raw) as Partial<T> & { id?: string };
        if (typeof raw.id === "string" && /^[a-z]{3}_[a-z0-9]+$/.test(raw.id)) p.id = raw.id;
        if (required.every((k) => p[k] !== undefined)) out.push(p);
      } catch { /* drop the record */ }
    }
    return out;
  };
  const tasks = clean<import("../core/index.js").Task>(data.tasks, (r) => ({ ...taskPatch(r), createdAt: typeof r.createdAt === "string" ? r.createdAt : undefined, completedAt: typeof r.completedAt === "string" ? r.completedAt : undefined }), ["title"]);
  for (const t of tasks) for (const k of Object.keys(t)) if (k.startsWith("__clear_")) delete (t as Record<string, unknown>)[k];
  return {
    ...data,
    prefs: data.prefs && typeof data.prefs === "object" ? (() => { try { const { apiKey: _k, ...p } = prefsPatch(data.prefs as Record<string, unknown>); return p; } catch { return undefined; } })() : undefined,
    tasks,
    events: clean<import("../core/index.js").Event>(data.events, eventPatch, ["title", "start", "end"]),
    memories: clean<import("../core/index.js").Memory>(data.memories, memoryPatch, ["text"]),
    people: clean<import("../core/index.js").Person>(data.people, personPatch, ["name"]),
    goals: clean<import("../core/index.js").Goal>(data.goals, goalPatch, ["title"]),
    rituals: clean<import("../core/index.js").Ritual>(data.rituals, (r) => { const p = ritualPatch(r); return { ...p, kind: typeof r.kind === "string" ? (r.kind as import("../core/index.js").Ritual["kind"]) : undefined, rule: p.rule && p.rule.freq ? (p.rule as import("../core/index.js").RRule) : undefined }; }, ["name", "kind", "rule"]),
    watchers: clean<import("../core/index.js").Watcher>(data.watchers, (r) => ({ ...watcherPatch(r), kind: typeof r.kind === "string" ? (r.kind as import("../core/index.js").Watcher["kind"]) : undefined }), ["name", "kind"]),
    outcomes: Array.isArray(data.outcomes) ? data.outcomes.filter((o) => o && typeof o === "object" && typeof (o as { taskId?: unknown }).taskId === "string" && ["deep", "light", "admin", "social"].includes(String((o as { energy?: unknown }).energy)) && typeof (o as { completedAt?: unknown }).completedAt === "string") : [],
  };
}

/** A believable first day, so the product is legible in 10 seconds. */
export function seedDemo(repo: Repo, now: Date): void {
  type Task = import("../core/index.js").Task;
  const prefs = repo.getPrefs();
  if (!prefs.name) repo.setPrefs({ name: "Will" });
  const tz = repo.getPrefs().timezone;
  /** local wall-clock time on today+dayOffset in the person's zone */
  const L = (h: number, m = 0, dayOffset = 0) => setTime(addDays(startOfDay(now, tz), dayOffset, tz), h, m, tz).toISOString();

  const priya = repo.findPerson("Priya") ?? repo.createPerson({ name: "Priya", relation: "colleague", cadenceDays: 14, notes: "Design lead. Loves systems thinking.", lastContactAt: new Date(now.getTime() - 20 * 86400_000).toISOString() });
  const sam = repo.findPerson("Sam") ?? repo.createPerson({ name: "Sam", relation: "mentor", cadenceDays: 30, lastContactAt: new Date(now.getTime() - 45 * 86400_000).toISOString() });
  if (!repo.findPerson("Dana")) repo.createPerson({ name: "Dana", relation: "friend", cadenceDays: 21, lastContactAt: new Date(now.getTime() - 3 * 86400_000).toISOString() });
  if (!repo.findPerson("Mom")) repo.createPerson({ name: "Mom", relation: "mother", cadenceDays: 7, lastContactAt: new Date(now.getTime() - 9 * 86400_000).toISOString() });

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
  if (repo.listGoals(true).length === 0) {
    const g = repo.createGoal({ title: "Ship Kairos v1", why: "The whole quarter is this.", horizon: "quarter", targetDate: new Date(now.getTime() + 55 * 86400_000).toISOString(), progress: 0.35, pinned: true });
    repo.createGoal({ title: "Run a 10k without stopping", horizon: "quarter", targetDate: new Date(now.getTime() + 70 * 86400_000).toISOString(), progress: 0.5 });
    for (const t of repo.listTasks({ status: "open" })) if (/investor|offsite|onboarding|design doc/i.test(t.title)) repo.updateTask(t.id, { goalId: g.id });
    // a month of history so the mirror has something to reflect
    const hist: [string, Task["energy"], number, number, number, number][] = [
      ["Draft pricing page", "deep", 60, 110, 9, -20], ["Write launch post", "deep", 90, 170, 10, -18], ["Outline talk", "deep", 45, 80, 9, -15], ["Spec the API", "deep", 120, 190, 10, -12], ["Review PRs", "light", 30, 35, 14, -19],
      ["Read design doc", "light", 30, 30, 15, -16], ["Skim papers", "light", 45, 40, 14, -9], ["Pay taxes", "admin", 60, 55, 16, -17], ["Renew domain", "admin", 15, 15, 17, -14], ["Expense report", "admin", 30, 25, 16, -11],
      ["Book travel", "admin", 30, 40, 17, -6], ["Call Dana", "social", 30, 30, 12, -13], ["Coffee with Priya", "social", 45, 50, 13, -8], ["1:1 prep", "social", 20, 20, 12, -5], ["Fix onboarding bug", "deep", 60, 120, 11, -4],
      ["Write weekly update", "deep", 30, 60, 10, -3], ["Clean inbox", "admin", 30, 25, 17, -2], ["Prep board deck", "deep", 120, 210, 9, -1],
      ["Refactor auth module", "deep", 90, 150, 9, -22], ["Design onboarding v2", "deep", 120, 200, 10, -23], ["Answer support tickets", "admin", 45, 40, 16, -21], ["Update CRM", "admin", 20, 20, 17, -24],
      ["Team lunch", "social", 60, 60, 12, -25], ["Call the accountant", "social", 20, 25, 13, -26], ["Read competitor teardown", "light", 40, 35, 14, -27], ["Triage bug list", "light", 30, 30, 15, -28],
    ];
    for (const [title, energy, est, actual, hour, dayOff] of hist) {
      const completedAt = new Date(L(hour, 0, dayOff));
      const t = repo.createTask({ title, energy, estimateMin: est, priority: 3, status: "done", completedAt: completedAt.toISOString(), createdAt: new Date(completedAt.getTime() - 3 * 86400_000).toISOString(), source: "import", due: dayOff % 3 === 0 ? new Date(completedAt.getTime() - 86400_000).toISOString() : undefined });
      repo.addOutcome({ taskId: t.id, title, energy, tags: [], estimateMin: est, actualMin: actual, completedAt: completedAt.toISOString(), hour, weekday: new Date(completedAt).getUTCDay(), slipped: dayOff % 3 === 0, onPlan: dayOff % 4 !== 0 });
    }
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
