/**
 * Minimal, dependency-free timezone math built on Intl.
 * All core logic works in "zoned parts" so the planner and parser are
 * deterministic regardless of the host machine's local zone.
 */

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday ... 6 = Saturday
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** Break a Date into wall-clock parts in the given zone. */
export function toZoned(date: Date, tz: string): ZonedParts {
  const parts = formatter(tz).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAYS.indexOf(get("weekday")),
  };
}

/** Offset (minutes east of UTC) of the zone at the given instant. */
export function offsetMinutes(date: Date, tz: string): number {
  const p = toZoned(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

/** Build a Date from wall-clock parts in the given zone (handles DST by iteration). */
export function fromZoned(
  p: { year: number; month: number; day: number; hour?: number; minute?: number; second?: number },
  tz: string,
): Date {
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour ?? 0, p.minute ?? 0, p.second ?? 0);
  let guess = new Date(wall - offsetMinutes(new Date(wall), tz) * 60000);
  // second pass corrects around DST transitions
  const off2 = offsetMinutes(guess, tz);
  guess = new Date(wall - off2 * 60000);
  return guess;
}

export function startOfDay(date: Date, tz: string): Date {
  const p = toZoned(date, tz);
  return fromZoned({ year: p.year, month: p.month, day: p.day }, tz);
}

export function addDays(date: Date, days: number, tz: string): Date {
  const p = toZoned(date, tz);
  return fromZoned(
    { year: p.year, month: p.month, day: p.day + days, hour: p.hour, minute: p.minute, second: p.second },
    tz,
  );
}

export function setTime(date: Date, hour: number, minute: number, tz: string): Date {
  const p = toZoned(date, tz);
  return fromZoned({ year: p.year, month: p.month, day: p.day, hour, minute }, tz);
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60000);
}

export function minutesBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 60000);
}

export function sameDay(a: Date, b: Date, tz: string): boolean {
  const pa = toZoned(a, tz);
  const pb = toZoned(b, tz);
  return pa.year === pb.year && pa.month === pb.month && pa.day === pb.day;
}

/** "YYYY-MM-DD" key for a date in a zone. */
export function dayKey(date: Date, tz: string): string {
  const p = toZoned(date, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function parseDayKey(key: string, tz: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  return fromZoned({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }, tz);
}

/** Minutes since midnight in the zone. */
export function minuteOfDay(date: Date, tz: string): number {
  const p = toZoned(date, tz);
  return p.hour * 60 + p.minute;
}

export function formatTime(date: Date, tz: string, hour12 = true): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12,
  }).format(date);
}

export function formatDate(date: Date, tz: string, opts: Intl.DateTimeFormatOptions = {}): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    ...opts,
  }).format(date);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
