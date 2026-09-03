import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app.js";
import { taskPatch, prefsPatch, eventPatch, ValidationError } from "../src/server/validate.js";
import { seal, open, secretKey, resetSecretCache } from "../src/server/secrets.js";
import { openDb } from "../src/server/db.js";

const now = () => new Date("2026-09-03T12:30:00Z");

describe("validation", () => {
  it("drops unknown keys, bounds strings, rejects bad types", () => {
    const p = taskPatch({ title: "  x  ".padEnd(400, "y"), evil: "drop table", priority: "2", estimateMin: 10, energy: "deep" } as never);
    expect((p as Record<string, unknown>).evil).toBeUndefined();
    expect(p.title!.length).toBe(300);
    expect(p.priority).toBe(2);
    expect(() => taskPatch({ priority: 9 })).toThrow(ValidationError);
    expect(() => taskPatch({ estimateMin: 1 })).toThrow(/estimateMin/);
    expect(() => taskPatch({ title: 12 })).toThrow(ValidationError);
    expect(() => taskPatch({ due: "not a date" })).toThrow(ValidationError);
    expect(() => eventPatch({ start: "2026-09-03T10:00:00Z", end: "2026-09-03T09:00:00Z" })).toThrow(/after start/);
  });
  it("prefs: validates timezone, workday, api key shape", () => {
    expect(() => prefsPatch({ timezone: "Mars/Olympus" })).toThrow(/timezone/);
    expect(() => prefsPatch({ workdayStartMin: 600, workdayEndMin: 500 })).toThrow(/workday/);
    expect(() => prefsPatch({ apiKey: "hunter2" })).toThrow(/API key/);
    expect(prefsPatch({ apiKey: null }).apiKey).toBeNull();
    expect(prefsPatch({ autonomy: "guardian", theme: "dark" })).toMatchObject({ autonomy: "guardian", theme: "dark" });
  });
});

describe("secrets", () => {
  it("seals and opens; tampering fails closed; legacy plaintext passes through", () => {
    const key = secretKey(":memory:");
    const sealed = seal("sk-ant-secret", key);
    expect(sealed.startsWith("enc:v1:")).toBe(true);
    expect(open(sealed, key)).toBe("sk-ant-secret");
    expect(open(sealed.slice(0, -2) + "xx", key)).toBeUndefined();
    expect(open("plain-legacy", key)).toBe("plain-legacy");
  });
});

describe("app hardening", () => {
  const dir = mkdtempSync(join(tmpdir(), "kairos-test-"));
  const ctx = createApp({ now, webDir: "/nonexistent", dbPath: join(dir, "t.db"), log: false, backupDir: join(dir, "bk") });
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await ctx.app.request(path, { method, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  it("rejects invalid patches with 400 and a message", async () => {
    const t = ctx.repo.createTask({ title: "x" });
    const r = await call("PATCH", `/api/tasks/${t.id}`, { priority: 42 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/priority/);
    const ok = await call("PATCH", `/api/tasks/${t.id}`, { priority: 1, due: null });
    expect(ok.status).toBe(200);
    expect(ok.body.priority).toBe(1);
  });
  it("rejects oversized bodies with 413", async () => {
    const r = await call("POST", "/api/tasks", { title: "x" }, { "content-length": String(3 * 1024 * 1024) });
    expect(r.status).toBe(413);
  });
  it("stores the API key encrypted and reports mode=claude", async () => {
    const r = await call("PUT", "/api/prefs", { apiKey: "sk-ant-api03-" + "a".repeat(40) });
    expect(r.status).toBe(200);
    expect(r.body.hasApiKey).toBe(true);
    const raw = ctx.repo.getMeta("anthropic_api_key")!;
    expect(raw.startsWith("enc:v1:")).toBe(true);
    expect(raw).not.toContain("sk-ant");
    expect((await call("GET", "/api/health")).body.mode).toBe("claude");
    await call("PUT", "/api/prefs", { apiKey: null });
    expect((await call("GET", "/api/health")).body.mode).toBe("local");
  });
  it("writes backups, prunes, and reports the last one in health", async () => {
    const r = await call("POST", "/api/backup");
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(readdirSync(join(dir, "bk")).length).toBe(1);
    const h = (await call("GET", "/api/health")).body;
    expect(h.lastBackupAt).toBeTruthy();
    expect(h.uptimeSec).toBeGreaterThanOrEqual(0);
  });
  it("scheduler contains a failing watcher instead of crashing the tick", () => {
    const w = ctx.repo.upsertWatcher({ kind: "deadline_risk", name: "boom", threshold: 0.5, cooldownMin: 1 });
    const orig = ctx.svc.futures.bind(ctx.svc);
    (ctx.svc as unknown as { futures: () => never }).futures = () => { throw new Error("simulated failure"); };
    const fired = ctx.scheduler.tick();
    expect(fired.errors.some((e) => e.includes(w.id) && e.includes("simulated failure"))).toBe(true);
    (ctx.svc as unknown as { futures: typeof orig }).futures = orig;
  });
  it("close() stops the scheduler and closes the db", () => {
    ctx.close();
    expect(() => ctx.repo.listTasks()).toThrow();
    rmSync(dir, { recursive: true, force: true });
    resetSecretCache();
  });
});

describe("migrations", () => {
  it("upgrades a v1 database to the current schema without losing rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kairos-mig-"));
    const path = join(dir, "v1.db");
    // Build a v1-shaped database by hand (tasks without goal_id, no goals/outcomes/ledger tables).
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(path);
    raw.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES('schema_version','1');
      CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT, status TEXT NOT NULL, priority INTEGER NOT NULL, energy TEXT NOT NULL, estimate_min INTEGER NOT NULL, due TEXT, pinned_start TEXT, planned_start TEXT, planned_end TEXT, snoozed_until TEXT, project TEXT, tags TEXT NOT NULL DEFAULT '[]', people_ids TEXT NOT NULL DEFAULT '[]', recurrence TEXT, source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT);
      INSERT INTO tasks(id,title,status,priority,energy,estimate_min,source,created_at,updated_at) VALUES('t1','legacy','open',3,'light',30,'user','2026-01-01','2026-01-01');
      CREATE TABLE events (id TEXT PRIMARY KEY, title TEXT NOT NULL, start TEXT NOT NULL, "end" TEXT NOT NULL, all_day INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL, location TEXT, notes TEXT, people_ids TEXT NOT NULL DEFAULT '[]', recurrence TEXT, source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, kind TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', importance REAL NOT NULL, confidence REAL NOT NULL, source TEXT NOT NULL, evidence TEXT, pinned INTEGER NOT NULL DEFAULT 0, access_count INTEGER NOT NULL DEFAULT 0, last_accessed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT);
      CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT NOT NULL, relation TEXT, notes TEXT, tags TEXT NOT NULL DEFAULT '[]', last_contact_at TEXT, cadence_days INTEGER, birthday TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE rituals (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, rule TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, prompt TEXT, last_run_at TEXT, created_at TEXT NOT NULL);
      CREATE TABLE watchers (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, threshold REAL NOT NULL, cooldown_min INTEGER NOT NULL, last_fired_at TEXT);
      CREATE TABLE nudges (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, level TEXT NOT NULL, cards TEXT, actions TEXT, origin TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT, dismissed_at TEXT);
      CREATE TABLE turns (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, cards TEXT, tool_calls TEXT, created_at TEXT NOT NULL);
      CREATE TABLE plans (date TEXT PRIMARY KEY, plan TEXT NOT NULL, generated_at TEXT NOT NULL);
      CREATE TABLE focus_sessions (id TEXT PRIMARY KEY, task_id TEXT, title TEXT NOT NULL, minutes INTEGER NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, outcome TEXT);`);
    raw.close();
    const db = openDb(path);
    const version = (db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value;
    expect(Number(version)).toBeGreaterThanOrEqual(2);
    const cols = (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("goal_id");
    expect((db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('goals','outcomes','ledger')").all() as unknown[]).length).toBe(3);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
