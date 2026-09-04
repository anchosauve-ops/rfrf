import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = DatabaseSync;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT, status TEXT NOT NULL, priority INTEGER NOT NULL,
    energy TEXT NOT NULL, estimate_min INTEGER NOT NULL, due TEXT, pinned_start TEXT, planned_start TEXT, planned_end TEXT,
    snoozed_until TEXT, project TEXT, tags TEXT NOT NULL DEFAULT '[]', people_ids TEXT NOT NULL DEFAULT '[]',
    recurrence TEXT, source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks(status, due);
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, start TEXT NOT NULL, "end" TEXT NOT NULL, all_day INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL, location TEXT, notes TEXT, people_ids TEXT NOT NULL DEFAULT '[]', recurrence TEXT,
    source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_start ON events(start);
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY, text TEXT NOT NULL, kind TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
    importance REAL NOT NULL, confidence REAL NOT NULL, source TEXT NOT NULL, evidence TEXT, pinned INTEGER NOT NULL DEFAULT 0,
    access_count INTEGER NOT NULL DEFAULT 0, last_accessed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT
  );
  CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, relation TEXT, notes TEXT, tags TEXT NOT NULL DEFAULT '[]',
    last_contact_at TEXT, cadence_days INTEGER, birthday TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rituals (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, rule TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    prompt TEXT, last_run_at TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS watchers (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    threshold REAL NOT NULL, cooldown_min INTEGER NOT NULL, last_fired_at TEXT
  );
  CREATE TABLE IF NOT EXISTS nudges (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, level TEXT NOT NULL, cards TEXT, actions TEXT,
    origin TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT, dismissed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS turns (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, cards TEXT, tool_calls TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_turns_conv ON turns(conversation_id, created_at);
  CREATE TABLE IF NOT EXISTS plans (date TEXT PRIMARY KEY, plan TEXT NOT NULL, generated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS focus_sessions (
    id TEXT PRIMARY KEY, task_id TEXT, title TEXT NOT NULL, minutes INTEGER NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, outcome TEXT
  );
  `,
  `
  ALTER TABLE tasks ADD COLUMN goal_id TEXT;
  CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, why TEXT, horizon TEXT NOT NULL, target_date TEXT,
    progress REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', pinned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS outcomes (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, title TEXT NOT NULL, energy TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
    goal_id TEXT, estimate_min INTEGER NOT NULL, actual_min INTEGER, planned_start TEXT, completed_at TEXT NOT NULL,
    hour INTEGER NOT NULL, weekday INTEGER NOT NULL, slipped INTEGER NOT NULL, on_plan INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_outcomes_completed ON outcomes(completed_at);
  CREATE TABLE IF NOT EXISTS ledger (
    id TEXT PRIMARY KEY, action TEXT NOT NULL, summary TEXT NOT NULL, reason TEXT NOT NULL, undo TEXT NOT NULL,
    origin TEXT NOT NULL, created_at TEXT NOT NULL, undone_at TEXT
  );
  `,
  `
  ALTER TABLE people ADD COLUMN hourly_rate REAL;
  ALTER TABLE people ADD COLUMN currency TEXT;
  ALTER TABLE people ADD COLUMN expected_weekly_hours REAL;
  CREATE TABLE IF NOT EXISTS worklogs (
    id TEXT PRIMARY KEY, person_id TEXT NOT NULL, date TEXT NOT NULL, minutes INTEGER NOT NULL,
    source TEXT NOT NULL, note TEXT, imported_at TEXT NOT NULL,
    UNIQUE(person_id, date)
  );
  CREATE INDEX IF NOT EXISTS idx_worklogs_person_date ON worklogs(person_id, date);
  `,
];

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const current = Number(
    (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string } | undefined)?.value ?? 0,
  ) || 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec("BEGIN");
    db.exec(MIGRATIONS[i]!);
    db.prepare("INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(i + 1));
    db.exec("COMMIT");
  }
  return db;
}
