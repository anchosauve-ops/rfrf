/**
 * Repository — the only module that speaks SQL. Everything above it works
 * with plain domain objects from src/core.
 */
import type { DB } from "./db.js";
import {
  DEFAULT_PREFERENCES,
  uid,
  type Event,
  type Memory,
  type Nudge,
  type Person,
  type Plan,
  type Preferences,
  type Ritual,
  type Task,
  type Turn,
  type Watcher,
} from "../core/index.js";

type Row = Record<string, unknown>;
const j = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));
const pj = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== "string") return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};
const s = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));
const nowIso = () => new Date().toISOString();

export class Repo {
  constructor(public readonly db: DB) {}

  // ---------- preferences ----------
  getPrefs(): Preferences {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'prefs'").get() as { value?: string } | undefined;
    return { ...DEFAULT_PREFERENCES, ...pj<Partial<Preferences>>(row?.value, {}) };
  }
  setPrefs(patch: Partial<Preferences>): Preferences {
    const next = { ...this.getPrefs(), ...patch };
    this.db
      .prepare("INSERT INTO meta(key, value) VALUES('prefs', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(next));
    return next;
  }
  getMeta(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value?: string } | undefined)?.value;
  }
  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  // ---------- tasks ----------
  private rowToTask(r: Row): Task {
    return {
      id: String(r.id),
      title: String(r.title),
      notes: s(r.notes),
      status: r.status as Task["status"],
      priority: Number(r.priority) as Task["priority"],
      energy: r.energy as Task["energy"],
      estimateMin: Number(r.estimate_min),
      due: s(r.due),
      pinnedStart: s(r.pinned_start),
      plannedStart: s(r.planned_start),
      plannedEnd: s(r.planned_end),
      snoozedUntil: s(r.snoozed_until),
      project: s(r.project),
      tags: pj<string[]>(r.tags, []),
      peopleIds: pj<string[]>(r.people_ids, []),
      recurrence: pj<Task["recurrence"]>(r.recurrence, undefined),
      source: r.source as Task["source"],
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      completedAt: s(r.completed_at),
    };
  }
  listTasks(opts: { status?: Task["status"] | "all"; limit?: number } = {}): Task[] {
    const status = opts.status ?? "open";
    const rows =
      status === "all"
        ? (this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?").all(opts.limit ?? 1000) as Row[])
        : (this.db.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY COALESCE(due, '9999') ASC, priority ASC LIMIT ?").all(status, opts.limit ?? 1000) as Row[]);
    return rows.map((r) => this.rowToTask(r));
  }
  getTask(id: string): Task | undefined {
    const r = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return r ? this.rowToTask(r) : undefined;
  }
  createTask(input: Partial<Task> & { title: string }): Task {
    const t: Task = {
      id: input.id ?? uid("tsk"),
      title: input.title.trim(),
      notes: input.notes,
      status: input.status ?? "open",
      priority: input.priority ?? 3,
      energy: input.energy ?? "light",
      estimateMin: input.estimateMin && input.estimateMin > 0 ? input.estimateMin : 30,
      due: input.due,
      pinnedStart: input.pinnedStart,
      plannedStart: input.plannedStart,
      plannedEnd: input.plannedEnd,
      snoozedUntil: input.snoozedUntil,
      project: input.project,
      tags: input.tags ?? [],
      peopleIds: input.peopleIds ?? [],
      recurrence: input.recurrence,
      source: input.source ?? "user",
      createdAt: input.createdAt ?? nowIso(),
      updatedAt: nowIso(),
      completedAt: input.completedAt,
    };
    this.db
      .prepare(
        `INSERT INTO tasks(id,title,notes,status,priority,energy,estimate_min,due,pinned_start,planned_start,planned_end,snoozed_until,project,tags,people_ids,recurrence,source,created_at,updated_at,completed_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(t.id, t.title, t.notes ?? null, t.status, t.priority, t.energy, t.estimateMin, t.due ?? null, t.pinnedStart ?? null, t.plannedStart ?? null, t.plannedEnd ?? null, t.snoozedUntil ?? null, t.project ?? null, JSON.stringify(t.tags), JSON.stringify(t.peopleIds), j(t.recurrence), t.source, t.createdAt, t.updatedAt, t.completedAt ?? null);
    return t;
  }
  updateTask(id: string, patch: Partial<Task>): Task | undefined {
    const cur = this.getTask(id);
    if (!cur) return undefined;
    const next: Task = { ...cur, ...patch, id, updatedAt: nowIso() };
    if (patch.status === "done" && !patch.completedAt) next.completedAt = nowIso();
    if (patch.status === "open") next.completedAt = undefined;
    this.db
      .prepare(
        `UPDATE tasks SET title=?,notes=?,status=?,priority=?,energy=?,estimate_min=?,due=?,pinned_start=?,planned_start=?,planned_end=?,snoozed_until=?,project=?,tags=?,people_ids=?,recurrence=?,source=?,updated_at=?,completed_at=? WHERE id=?`,
      )
      .run(next.title, next.notes ?? null, next.status, next.priority, next.energy, next.estimateMin, next.due ?? null, next.pinnedStart ?? null, next.plannedStart ?? null, next.plannedEnd ?? null, next.snoozedUntil ?? null, next.project ?? null, JSON.stringify(next.tags), JSON.stringify(next.peopleIds), j(next.recurrence), next.source, next.updatedAt, next.completedAt ?? null, id);
    return next;
  }
  deleteTask(id: string): boolean {
    return (this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id).changes ?? 0) > 0;
  }
  /** Fuzzy title lookup among open tasks (used by "done with the report"). */
  findTask(query: string, status: Task["status"] = "open"): Task | undefined {
    const q = query.toLowerCase().trim();
    if (!q) return undefined;
    const tasks = this.listTasks({ status });
    const exact = tasks.find((t) => t.title.toLowerCase() === q);
    if (exact) return exact;
    const contains = tasks.filter((t) => t.title.toLowerCase().includes(q) || q.includes(t.title.toLowerCase()));
    if (contains.length) return contains[0];
    const qt = q.split(/\s+/).filter((w) => w.length > 2);
    let best: { t: Task; n: number } | undefined;
    for (const t of tasks) {
      const words = t.title.toLowerCase();
      const n = qt.filter((w) => words.includes(w)).length;
      if (n && (!best || n > best.n)) best = { t, n };
    }
    return best && best.n / Math.max(1, qt.length) >= 0.5 ? best.t : undefined;
  }

  // ---------- events ----------
  private rowToEvent(r: Row): Event {
    return {
      id: String(r.id),
      title: String(r.title),
      start: String(r.start),
      end: String(r.end),
      allDay: !!r.all_day,
      kind: r.kind as Event["kind"],
      location: s(r.location),
      notes: s(r.notes),
      peopleIds: pj<string[]>(r.people_ids, []),
      recurrence: pj<Event["recurrence"]>(r.recurrence, undefined),
      source: r.source as Event["source"],
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }
  listEvents(range?: { from: string; to: string }): Event[] {
    const rows = range
      ? (this.db.prepare('SELECT * FROM events WHERE "end" > ? AND start < ? ORDER BY start ASC').all(range.from, range.to) as Row[])
      : (this.db.prepare("SELECT * FROM events ORDER BY start ASC").all() as Row[]);
    return rows.map((r) => this.rowToEvent(r));
  }
  getEvent(id: string): Event | undefined {
    const r = this.db.prepare("SELECT * FROM events WHERE id = ?").get(id) as Row | undefined;
    return r ? this.rowToEvent(r) : undefined;
  }
  createEvent(input: Partial<Event> & { title: string; start: string; end: string }): Event {
    const e: Event = {
      id: input.id ?? uid("evt"),
      title: input.title.trim(),
      start: input.start,
      end: input.end,
      allDay: input.allDay ?? false,
      kind: input.kind ?? "meeting",
      location: input.location,
      notes: input.notes,
      peopleIds: input.peopleIds ?? [],
      recurrence: input.recurrence,
      source: input.source ?? "user",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.db
      .prepare(`INSERT INTO events(id,title,start,"end",all_day,kind,location,notes,people_ids,recurrence,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(e.id, e.title, e.start, e.end, e.allDay ? 1 : 0, e.kind, e.location ?? null, e.notes ?? null, JSON.stringify(e.peopleIds), j(e.recurrence), e.source, e.createdAt, e.updatedAt);
    return e;
  }
  updateEvent(id: string, patch: Partial<Event>): Event | undefined {
    const cur = this.getEvent(id);
    if (!cur) return undefined;
    const next: Event = { ...cur, ...patch, id, updatedAt: nowIso() };
    this.db
      .prepare(`UPDATE events SET title=?,start=?,"end"=?,all_day=?,kind=?,location=?,notes=?,people_ids=?,recurrence=?,updated_at=? WHERE id=?`)
      .run(next.title, next.start, next.end, next.allDay ? 1 : 0, next.kind, next.location ?? null, next.notes ?? null, JSON.stringify(next.peopleIds), j(next.recurrence), next.updatedAt, id);
    return next;
  }
  deleteEvent(id: string): boolean {
    return (this.db.prepare("DELETE FROM events WHERE id = ?").run(id).changes ?? 0) > 0;
  }
  findEvent(query: string, after?: string): Event | undefined {
    const q = query.toLowerCase().trim();
    const events = this.listEvents(after ? { from: after, to: "9999" } : undefined);
    return events.find((e) => e.title.toLowerCase() === q) ?? events.find((e) => e.title.toLowerCase().includes(q));
  }

  // ---------- memories ----------
  private rowToMemory(r: Row): Memory {
    return {
      id: String(r.id),
      text: String(r.text),
      kind: r.kind as Memory["kind"],
      tags: pj<string[]>(r.tags, []),
      importance: Number(r.importance),
      confidence: Number(r.confidence),
      source: r.source as Memory["source"],
      evidence: s(r.evidence),
      pinned: !!r.pinned,
      accessCount: Number(r.access_count),
      lastAccessedAt: s(r.last_accessed_at),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      expiresAt: s(r.expires_at),
    };
  }
  listMemories(): Memory[] {
    return (this.db.prepare("SELECT * FROM memories ORDER BY pinned DESC, importance DESC, updated_at DESC").all() as Row[]).map((r) => this.rowToMemory(r));
  }
  getMemory(id: string): Memory | undefined {
    const r = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Row | undefined;
    return r ? this.rowToMemory(r) : undefined;
  }
  createMemory(input: Partial<Memory> & { text: string }): Memory {
    const m: Memory = {
      id: input.id ?? uid("mem"),
      text: input.text.trim(),
      kind: input.kind ?? "fact",
      tags: input.tags ?? [],
      importance: input.importance ?? 0.5,
      confidence: input.confidence ?? 0.8,
      source: input.source ?? "stated",
      evidence: input.evidence,
      pinned: input.pinned ?? false,
      accessCount: 0,
      lastAccessedAt: undefined,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      expiresAt: input.expiresAt,
    };
    this.db
      .prepare(`INSERT INTO memories(id,text,kind,tags,importance,confidence,source,evidence,pinned,access_count,last_accessed_at,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(m.id, m.text, m.kind, JSON.stringify(m.tags), m.importance, m.confidence, m.source, m.evidence ?? null, m.pinned ? 1 : 0, 0, null, m.createdAt, m.updatedAt, m.expiresAt ?? null);
    return m;
  }
  updateMemory(id: string, patch: Partial<Memory>): Memory | undefined {
    const cur = this.getMemory(id);
    if (!cur) return undefined;
    const next: Memory = { ...cur, ...patch, id, updatedAt: nowIso() };
    this.db
      .prepare(`UPDATE memories SET text=?,kind=?,tags=?,importance=?,confidence=?,source=?,evidence=?,pinned=?,access_count=?,last_accessed_at=?,updated_at=?,expires_at=? WHERE id=?`)
      .run(next.text, next.kind, JSON.stringify(next.tags), next.importance, next.confidence, next.source, next.evidence ?? null, next.pinned ? 1 : 0, next.accessCount, next.lastAccessedAt ?? null, next.updatedAt, next.expiresAt ?? null, id);
    return next;
  }
  touchMemories(ids: string[]): void {
    const stmt = this.db.prepare("UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?");
    const now = nowIso();
    for (const id of ids) stmt.run(now, id);
  }
  deleteMemory(id: string): boolean {
    return (this.db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes ?? 0) > 0;
  }

  // ---------- people ----------
  private rowToPerson(r: Row): Person {
    return {
      id: String(r.id),
      name: String(r.name),
      relation: s(r.relation),
      notes: s(r.notes),
      tags: pj<string[]>(r.tags, []),
      lastContactAt: s(r.last_contact_at),
      cadenceDays: r.cadence_days === null ? undefined : Number(r.cadence_days),
      birthday: s(r.birthday),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }
  listPeople(): Person[] {
    return (this.db.prepare("SELECT * FROM people ORDER BY name ASC").all() as Row[]).map((r) => this.rowToPerson(r));
  }
  getPerson(id: string): Person | undefined {
    const r = this.db.prepare("SELECT * FROM people WHERE id = ?").get(id) as Row | undefined;
    return r ? this.rowToPerson(r) : undefined;
  }
  findPerson(name: string): Person | undefined {
    const q = name.toLowerCase().trim();
    const people = this.listPeople();
    return people.find((p) => p.name.toLowerCase() === q) ?? people.find((p) => p.name.toLowerCase().split(/\s+/)[0] === q.split(/\s+/)[0]);
  }
  createPerson(input: Partial<Person> & { name: string }): Person {
    const p: Person = {
      id: input.id ?? uid("per"),
      name: input.name.trim(),
      relation: input.relation,
      notes: input.notes,
      tags: input.tags ?? [],
      lastContactAt: input.lastContactAt,
      cadenceDays: input.cadenceDays,
      birthday: input.birthday,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.db
      .prepare(`INSERT INTO people(id,name,relation,notes,tags,last_contact_at,cadence_days,birthday,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(p.id, p.name, p.relation ?? null, p.notes ?? null, JSON.stringify(p.tags), p.lastContactAt ?? null, p.cadenceDays ?? null, p.birthday ?? null, p.createdAt, p.updatedAt);
    return p;
  }
  updatePerson(id: string, patch: Partial<Person>): Person | undefined {
    const cur = this.getPerson(id);
    if (!cur) return undefined;
    const next: Person = { ...cur, ...patch, id, updatedAt: nowIso() };
    this.db
      .prepare(`UPDATE people SET name=?,relation=?,notes=?,tags=?,last_contact_at=?,cadence_days=?,birthday=?,updated_at=? WHERE id=?`)
      .run(next.name, next.relation ?? null, next.notes ?? null, JSON.stringify(next.tags), next.lastContactAt ?? null, next.cadenceDays ?? null, next.birthday ?? null, next.updatedAt, id);
    return next;
  }
  deletePerson(id: string): boolean {
    return (this.db.prepare("DELETE FROM people WHERE id = ?").run(id).changes ?? 0) > 0;
  }

  // ---------- rituals & watchers ----------
  listRituals(): Ritual[] {
    return (this.db.prepare("SELECT * FROM rituals ORDER BY created_at ASC").all() as Row[]).map((r) => ({
      id: String(r.id),
      name: String(r.name),
      kind: r.kind as Ritual["kind"],
      rule: pj<Ritual["rule"]>(r.rule, { freq: "daily", time: "08:00" }),
      enabled: !!r.enabled,
      prompt: s(r.prompt),
      lastRunAt: s(r.last_run_at),
      createdAt: String(r.created_at),
    }));
  }
  upsertRitual(rit: Partial<Ritual> & { name: string; kind: Ritual["kind"]; rule: Ritual["rule"] }): Ritual {
    const r: Ritual = { id: rit.id ?? uid("rit"), name: rit.name, kind: rit.kind, rule: rit.rule, enabled: rit.enabled ?? true, prompt: rit.prompt, lastRunAt: rit.lastRunAt, createdAt: rit.createdAt ?? nowIso() };
    this.db
      .prepare(`INSERT INTO rituals(id,name,kind,rule,enabled,prompt,last_run_at,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,rule=excluded.rule,enabled=excluded.enabled,prompt=excluded.prompt,last_run_at=excluded.last_run_at`)
      .run(r.id, r.name, r.kind, JSON.stringify(r.rule), r.enabled ? 1 : 0, r.prompt ?? null, r.lastRunAt ?? null, r.createdAt);
    return r;
  }
  deleteRitual(id: string): boolean {
    return (this.db.prepare("DELETE FROM rituals WHERE id = ?").run(id).changes ?? 0) > 0;
  }
  listWatchers(): Watcher[] {
    return (this.db.prepare("SELECT * FROM watchers").all() as Row[]).map((r) => ({
      id: String(r.id),
      kind: r.kind as Watcher["kind"],
      name: String(r.name),
      enabled: !!r.enabled,
      threshold: Number(r.threshold),
      cooldownMin: Number(r.cooldown_min),
      lastFiredAt: s(r.last_fired_at),
    }));
  }
  upsertWatcher(w: Partial<Watcher> & { kind: Watcher["kind"]; name: string }): Watcher {
    const x: Watcher = { id: w.id ?? uid("wat"), kind: w.kind, name: w.name, enabled: w.enabled ?? true, threshold: w.threshold ?? 1, cooldownMin: w.cooldownMin ?? 720, lastFiredAt: w.lastFiredAt };
    this.db
      .prepare(`INSERT INTO watchers(id,kind,name,enabled,threshold,cooldown_min,last_fired_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,name=excluded.name,enabled=excluded.enabled,threshold=excluded.threshold,cooldown_min=excluded.cooldown_min,last_fired_at=excluded.last_fired_at`)
      .run(x.id, x.kind, x.name, x.enabled ? 1 : 0, x.threshold, x.cooldownMin, x.lastFiredAt ?? null);
    return x;
  }

  // ---------- nudges ----------
  private rowToNudge(r: Row): Nudge {
    return {
      id: String(r.id),
      title: String(r.title),
      body: String(r.body),
      level: r.level as Nudge["level"],
      cards: pj<Nudge["cards"]>(r.cards, undefined),
      actions: pj<Nudge["actions"]>(r.actions, undefined),
      origin: String(r.origin),
      createdAt: String(r.created_at),
      readAt: s(r.read_at),
      dismissedAt: s(r.dismissed_at),
    };
  }
  listNudges(opts: { includeDismissed?: boolean; limit?: number } = {}): Nudge[] {
    const rows = opts.includeDismissed
      ? (this.db.prepare("SELECT * FROM nudges ORDER BY created_at DESC LIMIT ?").all(opts.limit ?? 100) as Row[])
      : (this.db.prepare("SELECT * FROM nudges WHERE dismissed_at IS NULL ORDER BY created_at DESC LIMIT ?").all(opts.limit ?? 100) as Row[]);
    return rows.map((r) => this.rowToNudge(r));
  }
  createNudge(input: Omit<Nudge, "id" | "createdAt"> & { id?: string }): Nudge {
    const n: Nudge = { ...input, id: input.id ?? uid("ndg"), createdAt: nowIso() };
    this.db
      .prepare(`INSERT INTO nudges(id,title,body,level,cards,actions,origin,created_at,read_at,dismissed_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(n.id, n.title, n.body, n.level, j(n.cards), j(n.actions), n.origin, n.createdAt, null, null);
    return n;
  }
  markNudge(id: string, field: "read" | "dismissed"): void {
    this.db.prepare(`UPDATE nudges SET ${field}_at = ? WHERE id = ?`).run(nowIso(), id);
  }
  recentNudgeFrom(origin: string, withinMin: number): boolean {
    const since = new Date(Date.now() - withinMin * 60000).toISOString();
    const r = this.db.prepare("SELECT 1 FROM nudges WHERE origin = ? AND created_at > ? LIMIT 1").get(origin, since);
    return !!r;
  }

  // ---------- conversation ----------
  addTurn(t: Omit<Turn, "id" | "createdAt"> & { id?: string }): Turn {
    const turn: Turn = { ...t, id: t.id ?? uid("trn"), createdAt: nowIso() };
    this.db
      .prepare(`INSERT INTO turns(id,conversation_id,role,text,cards,tool_calls,created_at) VALUES(?,?,?,?,?,?,?)`)
      .run(turn.id, turn.conversationId, turn.role, turn.text, j(turn.cards), j(turn.toolCalls), turn.createdAt);
    return turn;
  }
  listTurns(conversationId: string, limit = 40): Turn[] {
    const rows = this.db
      .prepare("SELECT * FROM turns WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(conversationId, limit) as Row[];
    return rows.reverse().map((r) => ({
      id: String(r.id),
      conversationId: String(r.conversation_id),
      role: r.role as Turn["role"],
      text: String(r.text),
      cards: pj<Turn["cards"]>(r.cards, undefined),
      toolCalls: pj<Turn["toolCalls"]>(r.tool_calls, undefined),
      createdAt: String(r.created_at),
    }));
  }
  clearConversation(conversationId: string): void {
    this.db.prepare("DELETE FROM turns WHERE conversation_id = ?").run(conversationId);
  }

  // ---------- plans ----------
  getPlan(date: string): Plan | undefined {
    const r = this.db.prepare("SELECT plan FROM plans WHERE date = ?").get(date) as { plan?: string } | undefined;
    return pj<Plan | undefined>(r?.plan, undefined);
  }
  savePlan(plan: Plan): void {
    this.db
      .prepare("INSERT INTO plans(date, plan, generated_at) VALUES(?,?,?) ON CONFLICT(date) DO UPDATE SET plan = excluded.plan, generated_at = excluded.generated_at")
      .run(plan.date, JSON.stringify(plan), plan.generatedAt);
  }

  // ---------- focus ----------
  startFocus(input: { taskId?: string; title: string; minutes: number }): { id: string; startedAt: string } {
    const id = uid("foc");
    const startedAt = nowIso();
    this.db.prepare("INSERT INTO focus_sessions(id,task_id,title,minutes,started_at) VALUES(?,?,?,?,?)").run(id, input.taskId ?? null, input.title, input.minutes, startedAt);
    return { id, startedAt };
  }
  endFocus(id: string, outcome: string): void {
    this.db.prepare("UPDATE focus_sessions SET ended_at = ?, outcome = ? WHERE id = ?").run(nowIso(), outcome, id);
  }
  focusMinutesSince(iso: string): number {
    const r = this.db.prepare("SELECT COALESCE(SUM(minutes),0) AS m FROM focus_sessions WHERE started_at > ? AND ended_at IS NOT NULL AND outcome = 'completed'").get(iso) as { m: number };
    return Number(r.m);
  }

  // ---------- export / import ----------
  exportAll(): Record<string, unknown> {
    return {
      version: 1,
      exportedAt: nowIso(),
      prefs: this.getPrefs(),
      tasks: this.listTasks({ status: "all" }),
      events: this.listEvents(),
      memories: this.listMemories(),
      people: this.listPeople(),
      rituals: this.listRituals(),
      watchers: this.listWatchers(),
      nudges: this.listNudges({ includeDismissed: true, limit: 500 }),
    };
  }
  importAll(data: Record<string, unknown>): { imported: Record<string, number> } {
    const counts: Record<string, number> = {};
    const arr = <T>(k: string): T[] => (Array.isArray(data[k]) ? (data[k] as T[]) : []);
    this.db.exec("BEGIN");
    try {
      if (data.prefs && typeof data.prefs === "object") this.setPrefs(data.prefs as Partial<Preferences>);
      for (const t of arr<Task>("tasks")) if (!this.getTask(t.id)) { this.createTask({ ...t, source: "import" }); counts.tasks = (counts.tasks ?? 0) + 1; }
      for (const e of arr<Event>("events")) if (!this.getEvent(e.id)) { this.createEvent({ ...e, source: "import" }); counts.events = (counts.events ?? 0) + 1; }
      for (const m of arr<Memory>("memories")) if (!this.getMemory(m.id)) { this.createMemory({ ...m, source: m.source ?? "imported" }); counts.memories = (counts.memories ?? 0) + 1; }
      for (const p of arr<Person>("people")) if (!this.getPerson(p.id)) { this.createPerson(p); counts.people = (counts.people ?? 0) + 1; }
      for (const r of arr<Ritual>("rituals")) { this.upsertRitual(r); counts.rituals = (counts.rituals ?? 0) + 1; }
      for (const w of arr<Watcher>("watchers")) { this.upsertWatcher(w); counts.watchers = (counts.watchers ?? 0) + 1; }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { imported: counts };
  }

  /** Seed the rituals/watchers a fresh install should have. Idempotent. */
  ensureDefaults(): void {
    if (this.listRituals().length === 0) {
      this.upsertRitual({ id: "rit_morning", name: "Morning brief", kind: "morning_brief", rule: { freq: "daily", time: "07:30" } });
      this.upsertRitual({ id: "rit_evening", name: "Evening review", kind: "evening_review", rule: { freq: "daily", time: "18:30" } });
      this.upsertRitual({ id: "rit_weekly", name: "Weekly retro", kind: "weekly_retro", rule: { freq: "weekly", byWeekday: [5], time: "16:00" } });
    }
    if (this.listWatchers().length === 0) {
      this.upsertWatcher({ id: "wat_overdue", kind: "overdue_tasks", name: "Overdue tasks", threshold: 1, cooldownMin: 12 * 60 });
      this.upsertWatcher({ id: "wat_people", kind: "stale_people", name: "People drifting", threshold: 1.25, cooldownMin: 24 * 60 });
      this.upsertWatcher({ id: "wat_overload", kind: "overloaded_day", name: "Overloaded day", threshold: 95, cooldownMin: 24 * 60 });
      this.upsertWatcher({ id: "wat_deadline", kind: "deadline_approaching", name: "Deadline approaching", threshold: 48, cooldownMin: 12 * 60 });
      this.upsertWatcher({ id: "wat_unplanned", kind: "unplanned_day", name: "Unplanned day", threshold: 0, cooldownMin: 24 * 60 });
    }
  }
}
