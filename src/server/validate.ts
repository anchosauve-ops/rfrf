/**
 * Validation — every write that arrives over HTTP passes through here.
 * Small, explicit sanitizers: unknown keys dropped, types coerced or
 * rejected, strings bounded. Returns a clean patch or throws a 400-able error.
 */
import type { Event, Goal, Memory, Person, Preferences, Ritual, Task, Watcher } from "../core/index.js";
import { isValidTimeZone } from "../core/index.js";

export class ValidationError extends Error {
  status = 400;
}

const MAX_TEXT = 4000;
const MAX_TITLE = 300;

type Raw = Record<string, unknown>;

function str(v: unknown, max = MAX_TEXT, name = "field"): string | undefined {
  if (v === undefined) return undefined;
  if (v === null) return undefined;
  if (typeof v !== "string") throw new ValidationError(`${name} must be a string`);
  const s = v.trim();
  return s.length > max ? s.slice(0, max) : s;
}
function nullableStr(v: unknown, max = MAX_TEXT, name = "field"): string | null | undefined {
  if (v === null) return null;
  return str(v, max, name);
}
function iso(v: unknown, name: string): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string" || Number.isNaN(new Date(v).getTime())) throw new ValidationError(`${name} must be an ISO-8601 timestamp`);
  return new Date(v).toISOString();
}
function int(v: unknown, name: string, min: number, max: number): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new ValidationError(`${name} must be a number`);
  const r = Math.round(n);
  if (r < min || r > max) throw new ValidationError(`${name} must be between ${min} and ${max}`);
  return r;
}
function num(v: unknown, name: string, min: number, max: number): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new ValidationError(`${name} must be a number`);
  if (n < min || n > max) throw new ValidationError(`${name} must be between ${min} and ${max}`);
  return n;
}
function bool(v: unknown, name: string): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "boolean") return v;
  if (v === 1 || v === "true" || v === "1") return true;
  if (v === 0 || v === "false" || v === "0") return false;
  throw new ValidationError(`${name} must be a boolean`);
}
function oneOf<T extends string>(v: unknown, name: string, allowed: readonly T[]): T | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !allowed.includes(v as T)) throw new ValidationError(`${name} must be one of ${allowed.join(", ")}`);
  return v as T;
}
function strArr(v: unknown, name: string, max = 50): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new ValidationError(`${name} must be an array of strings`);
  return v.filter((x): x is string => typeof x === "string").map((x) => x.trim().slice(0, 100)).filter(Boolean).slice(0, max);
}
/** drop undefined so PATCH semantics hold */
function compact<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}
/** null → undefined for optional fields we want to clear */
const clear = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);

export function taskPatch(raw: Raw): Partial<Task> {
  const p: Partial<Task> & { due?: string; pinnedStart?: string; snoozedUntil?: string } = compact({
    title: str(raw.title, MAX_TITLE, "title"),
    notes: clear(nullableStr(raw.notes, MAX_TEXT, "notes")),
    status: oneOf(raw.status, "status", ["open", "done", "dropped"] as const),
    priority: int(raw.priority, "priority", 1, 4) as Task["priority"] | undefined,
    energy: oneOf(raw.energy, "energy", ["deep", "light", "admin", "social"] as const),
    estimateMin: int(raw.estimateMin ?? raw.estimate_min, "estimateMin", 5, 24 * 60),
    project: clear(nullableStr(raw.project, 100, "project")),
    goalId: clear(nullableStr(raw.goalId, 64, "goalId")),
    tags: strArr(raw.tags, "tags"),
    peopleIds: strArr(raw.peopleIds, "peopleIds"),
  });
  // explicit clears: null means "remove"
  for (const k of ["due", "pinnedStart", "snoozedUntil"] as const) {
    const v = iso(raw[k], k);
    if (v === null) {
      (p as Record<string, unknown>)[k] = undefined;
      (p as Record<string, unknown>)[`__clear_${k}`] = true;
    } else if (v !== undefined) p[k] = v;
  }
  if (p.title !== undefined && !p.title) throw new ValidationError("title cannot be empty");
  return p;
}

export function eventPatch(raw: Raw): Partial<Event> {
  const p = compact({
    title: str(raw.title, MAX_TITLE, "title"),
    start: clear(iso(raw.start, "start")),
    end: clear(iso(raw.end, "end")),
    allDay: bool(raw.allDay ?? raw.all_day, "allDay"),
    kind: oneOf(raw.kind, "kind", ["meeting", "focus", "personal", "travel", "ritual"] as const),
    location: clear(nullableStr(raw.location, 300, "location")),
    notes: clear(nullableStr(raw.notes, MAX_TEXT, "notes")),
    peopleIds: strArr(raw.peopleIds, "peopleIds"),
  });
  if (p.start && p.end && new Date(p.end) <= new Date(p.start)) throw new ValidationError("end must be after start");
  return p;
}

export function memoryPatch(raw: Raw): Partial<Memory> {
  return compact({
    text: str(raw.text, MAX_TEXT, "text"),
    kind: oneOf(raw.kind, "kind", ["fact", "preference", "goal", "relationship", "insight", "episode"] as const),
    tags: strArr(raw.tags, "tags"),
    importance: num(raw.importance, "importance", 0, 1),
    confidence: num(raw.confidence, "confidence", 0, 1),
    source: oneOf(raw.source, "source", ["stated", "inferred", "imported"] as const),
    evidence: clear(nullableStr(raw.evidence, MAX_TEXT, "evidence")),
    pinned: bool(raw.pinned, "pinned"),
    expiresAt: clear(iso(raw.expiresAt, "expiresAt")),
  });
}

export function personPatch(raw: Raw): Partial<Person> {
  return compact({
    name: str(raw.name, 200, "name"),
    relation: clear(nullableStr(raw.relation, 100, "relation")),
    notes: clear(nullableStr(raw.notes, MAX_TEXT, "notes")),
    tags: strArr(raw.tags, "tags"),
    lastContactAt: clear(iso(raw.lastContactAt, "lastContactAt")),
    cadenceDays: int(raw.cadenceDays ?? raw.cadence_days, "cadenceDays", 1, 3650),
    birthday: clear(nullableStr(raw.birthday, 5, "birthday")),
    hourlyRate: raw.hourlyRate === null ? undefined : num(raw.hourlyRate ?? raw.hourly_rate, "hourlyRate", 0, 100000),
    currency: clear(nullableStr(raw.currency, 3, "currency"))?.toUpperCase(),
    expectedWeeklyHours: raw.expectedWeeklyHours === null ? undefined : num(raw.expectedWeeklyHours ?? raw.expected_weekly_hours, "expectedWeeklyHours", 0, 168),
  });
}

export function worklogImport(raw: Raw): { person?: string; personId?: string; days: { date: string; minutes: number }[]; source: "timeproof" | "paste" | "manual" | "import"; text?: string } {
  const person = str(raw.person, 200, "person");
  const personId = str(raw.personId, 64, "personId");
  const text = str(raw.text, 200_000, "text");
  const source = oneOf(raw.source, "source", ["timeproof", "paste", "manual", "import"] as const) ?? "import";
  const days: { date: string; minutes: number }[] = [];
  if (Array.isArray(raw.days)) {
    for (const d of raw.days.slice(0, 400)) {
      if (!d || typeof d !== "object") continue;
      const date = str((d as Raw).date, 10, "days.date");
      const minutes = int((d as Raw).minutes, "days.minutes", 0, 24 * 60);
      if (date && /^\d{4}-\d{2}-\d{2}$/.test(date) && minutes !== undefined) days.push({ date, minutes });
    }
  }
  if (!days.length && !text) throw new ValidationError("send days[] or text");
  return { person, personId, days, source, text };
}

export function goalPatch(raw: Raw): Partial<Goal> {
  return compact({
    title: str(raw.title, MAX_TITLE, "title"),
    why: clear(nullableStr(raw.why, MAX_TEXT, "why")),
    horizon: oneOf(raw.horizon, "horizon", ["week", "month", "quarter", "year"] as const),
    targetDate: clear(iso(raw.targetDate ?? raw.target_date, "targetDate")),
    progress: num(raw.progress, "progress", 0, 1),
    status: oneOf(raw.status, "status", ["active", "done", "paused"] as const),
    pinned: bool(raw.pinned, "pinned"),
  });
}

export type RitualPatch = Omit<Partial<Ritual>, "rule"> & { rule?: Partial<Ritual["rule"]> };
export function ritualPatch(raw: Raw): RitualPatch {
  const p: RitualPatch = compact({
    name: str(raw.name, 100, "name"),
    enabled: bool(raw.enabled, "enabled"),
    prompt: clear(nullableStr(raw.prompt, MAX_TEXT, "prompt")),
  });
  if (raw.rule && typeof raw.rule === "object") {
    const r = raw.rule as Raw;
    const time = str(r.time, 5, "rule.time");
    if (time !== undefined && !/^\d{2}:\d{2}$/.test(time)) throw new ValidationError("rule.time must be HH:MM");
    p.rule = compact({
      freq: oneOf(r.freq, "rule.freq", ["daily", "weekly", "monthly", "yearly"] as const),
      interval: int(r.interval, "rule.interval", 1, 52),
      byWeekday: Array.isArray(r.byWeekday) ? r.byWeekday.filter((d): d is number => typeof d === "number" && d >= 0 && d <= 6) : undefined,
      byMonthDay: int(r.byMonthDay, "rule.byMonthDay", 1, 31),
      time,
    });
  }
  return p;
}

export function watcherPatch(raw: Raw): Partial<Watcher> {
  return compact({
    name: str(raw.name, 100, "name"),
    enabled: bool(raw.enabled, "enabled"),
    threshold: num(raw.threshold, "threshold", 0, 100000),
    cooldownMin: int(raw.cooldownMin, "cooldownMin", 1, 60 * 24 * 30),
  });
}

export function prefsPatch(raw: Raw): Partial<Preferences> & { apiKey?: string | null } {
  const tz = str(raw.timezone, 64, "timezone");
  if (tz !== undefined && !isValidTimeZone(tz)) throw new ValidationError(`unknown timezone "${tz}"`);
  const p = compact({
    name: str(raw.name, 80, "name"),
    timezone: tz,
    workdayStartMin: int(raw.workdayStartMin, "workdayStartMin", 0, 24 * 60),
    workdayEndMin: int(raw.workdayEndMin, "workdayEndMin", 0, 24 * 60),
    workDays: Array.isArray(raw.workDays) ? [...new Set(raw.workDays.filter((d): d is number => typeof d === "number" && d >= 0 && d <= 6))].sort() : undefined,
    energyCurve: Array.isArray(raw.energyCurve)
      ? raw.energyCurve
          .filter((s): s is Raw => !!s && typeof s === "object")
          .map((s) => ({ fromMin: int(s.fromMin, "energyCurve.fromMin", 0, 24 * 60) ?? 0, toMin: int(s.toMin, "energyCurve.toMin", 0, 24 * 60) ?? 0, best: oneOf(s.best, "energyCurve.best", ["deep", "light", "admin", "social"] as const) ?? "light" }))
          .filter((s) => s.toMin > s.fromMin)
          .slice(0, 12)
      : undefined,
    focusBlockMin: int(raw.focusBlockMin, "focusBlockMin", 15, 240),
    breakMin: int(raw.breakMin, "breakMin", 0, 60),
    meetingBufferMin: int(raw.meetingBufferMin, "meetingBufferMin", 0, 30),
    theme: oneOf(raw.theme, "theme", ["system", "light", "dark"] as const),
    voice: bool(raw.voice, "voice"),
    model: str(raw.model, 80, "model"),
    autonomy: oneOf(raw.autonomy, "autonomy", ["ask", "act", "guardian"] as const),
    useCalibration: bool(raw.useCalibration, "useCalibration"),
    autoTuneCurve: bool(raw.autoTuneCurve, "autoTuneCurve"),
    onboarded: bool(raw.onboarded, "onboarded"),
  }) as Partial<Preferences> & { apiKey?: string | null };
  if (p.workdayStartMin !== undefined && p.workdayEndMin !== undefined && p.workdayEndMin <= p.workdayStartMin) throw new ValidationError("workday must end after it starts");
  if (raw.apiKey === null) p.apiKey = null;
  else if (typeof raw.apiKey === "string") {
    const k = raw.apiKey.trim();
    if (k && !/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k)) throw new ValidationError("that doesn't look like an Anthropic API key");
    p.apiKey = k || null;
  }
  return p;
}
