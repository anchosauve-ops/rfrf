/**
 * Work logs — hours a worker put in, and what that costs.
 *
 * Understands Timeproof calendars (OnlineJobs.ph) in three shapes: a scraped
 * JSON list from the bookmarklet, the text you get from select-all/copy on the
 * calendar page, and plain human lines ("Aug 31 7:04"). Week and month totals
 * that ride along in the copied text are recognized arithmetically and dropped.
 */
import type { Payroll, WorkLog } from "./types.js";
import { toZoned, dayKey } from "./tz.js";

export interface DayHours {
  date: string; // YYYY-MM-DD
  minutes: number;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_RE = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec";

export function parseHM(s: string): number | undefined {
  const m = /^(\d{1,3}):(\d{2})(?::\d{2})?$/.exec(s.trim());
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const h = /^(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?(?:\s*(\d+)\s*m(?:in(?:ute)?s?)?)?$/i.exec(s.trim());
  if (h) return Math.round(Number(h[1]) * 60 + Number(h[2] ?? 0));
  const mo = /^(\d+)\s*m(?:in(?:ute)?s?)?$/i.exec(s.trim());
  if (mo) return Number(mo[1]);
  return undefined;
}

export function fmtHM(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function key(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}
function daysIn(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
/** 0 = Sunday, computed from the civil date (zone-free). */
function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}
export function addDaysKey(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d! + n));
  return key(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
export function weekStart(date: string): string {
  return addDaysKey(date, -weekdayOf(date));
}

/**
 * Parse free text into day totals.
 * Accepts: "Aug 31 07:04", "31 Aug 7h 4m", "2026-08-31 7:04", "8/31 07:04",
 * and the select-all text of a Timeproof month ("August 2026 … 26 01:40 27 05:31 …").
 */
export function parseWorklogText(text: string, opts: { now: Date; tz: string }): { days: DayHours[]; dropped: { date: string; minutes: number; reason: string }[]; month?: string } {
  const nowZ = toZoned(opts.now, opts.tz);
  const out = new Map<string, number>();
  const dropped: { date: string; minutes: number; reason: string }[] = [];
  const lines = text.replace(/\r/g, "").split(/\n+/).map((l) => l.trim()).filter(Boolean);

  // 1. explicit dated lines
  let usedExplicit = false;
  const explicit = [
    new RegExp(`^(?:(\\d{4})-(\\d{2})-(\\d{2}))\\s*[:\\-–]?\\s*(.+)$`),
    new RegExp(`^(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\s*[:\\-–]?\\s*(.+)$`, "i"),
    new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_RE})\\.?(?:,?\\s+(\\d{4}))?\\s*[:\\-–]?\\s*(.+)$`, "i"),
    new RegExp(`^(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?\\s*[:\\-–]?\\s*(.+)$`),
  ];
  for (const line of lines) {
    let date: string | undefined;
    let rest: string | undefined;
    let m: RegExpExecArray | null;
    if ((m = explicit[0]!.exec(line))) { date = key(Number(m[1]), Number(m[2]), Number(m[3])); rest = m[4]; }
    else if ((m = explicit[1]!.exec(line))) { const mo = MONTHS[m[1]!.toLowerCase()]!; const y = m[3] ? Number(m[3]) : yearFor(mo, nowZ.year, nowZ.month); date = key(y, mo, Number(m[2])); rest = m[4]; }
    else if ((m = explicit[2]!.exec(line))) { const mo = MONTHS[m[2]!.toLowerCase()]!; const y = m[3] ? Number(m[3]) : yearFor(mo, nowZ.year, nowZ.month); date = key(y, mo, Number(m[1])); rest = m[4]; }
    else if ((m = explicit[3]!.exec(line))) { const mo = Number(m[1]); const d = Number(m[2]); if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) { let y = m[3] ? Number(m[3]) : yearFor(mo, nowZ.year, nowZ.month); if (y < 100) y += 2000; date = key(y, mo, d); rest = m[4]; } }
    if (date && rest) {
      const minutes = parseHM(rest.split(/\s{2,}|,|;/)[0]!.trim()) ?? parseHM(rest.trim());
      if (minutes !== undefined) {
        out.set(date, (out.get(date) ?? 0) + minutes);
        usedExplicit = true;
      }
    }
  }
  if (usedExplicit) return { days: [...out].map(([date, minutes]) => ({ date, minutes })).sort((a, b) => a.date.localeCompare(b.date)), dropped };

  // 2. Timeproof select-all text: a "Month YYYY" header, then day numbers interleaved with HH:MM values
  const header = new RegExp(`\\b(${MONTH_RE})\\s+(\\d{4})\\b`, "i").exec(text);
  if (!header) return { days: [], dropped };
  const month = MONTHS[header[1]!.toLowerCase()]!;
  const year = Number(header[2]);
  const body = text.slice(header.index + header[0].length);
  const tokens = body.match(/\d{1,3}:\d{2}|\b\d{1,2}\b/g) ?? [];
  // Walk the grid: day numbers ascend; leading/trailing out-of-month days are detected by order.
  const pairs: { date: string; minutes: number; sat: boolean; last: boolean }[] = [];
  let curDate: string | undefined;
  let seenFirstOfMonth = false;
  let prevDay = 0;
  let curMonth = month;
  let curYear = year;
  const dim = daysIn(year, month);
  for (const tk of tokens) {
    if (tk.includes(":")) {
      if (!curDate) continue;
      pairs.push({ date: curDate, minutes: parseHM(tk)!, sat: weekdayOf(curDate) === 6, last: curDate.endsWith(`-${pad(daysIn(curYear, curMonth))}`) });
      continue;
    }
    const d = Number(tk);
    if (d < 1 || d > 31) continue;
    if (!seenFirstOfMonth) {
      if (d === 1) { seenFirstOfMonth = true; curMonth = month; curYear = year; }
      else { // trailing days of the previous month
        const pm = month === 1 ? 12 : month - 1;
        const py = month === 1 ? year - 1 : year;
        curMonth = pm; curYear = py;
      }
    } else if (d < prevDay) { // rolled into next month
      curMonth = month === 12 ? 1 : month + 1;
      curYear = month === 12 ? year + 1 : year;
    } else if (d > dim && curMonth === month) continue;
    prevDay = d;
    curDate = key(curYear, curMonth, d);
  }
  // Disambiguate totals using the grid's structure:
  //  - in a cell with several values, the largest is a total (week or month), the rest are day values;
  //  - a lone value in a Saturday cell is a week total when it equals the week's classified day values;
  //  - a lone value in a month's last-day cell is a month total when it equals the month's classified day values;
  //  - anything over 24h is a total. Saturdays are classified before last days so week totals never inflate month sums.
  const cells = new Map<string, number[]>();
  for (const p of pairs) cells.set(p.date, [...(cells.get(p.date) ?? []), p.minutes]);
  const dayVals = new Map<string, number[]>(); // classified day values
  const pending: { date: string; minutes: number; sat: boolean; last: boolean }[] = [];
  for (const [date, vals] of cells) {
    const sat = weekdayOf(date) === 6;
    const [y, m] = date.split("-").map(Number);
    const last = date.endsWith(`-${pad(daysIn(y!, m!))}`);
    if (vals.length >= 2) {
      const sorted = [...vals].sort((a, b) => b - a);
      const totals = sorted.slice(0, sat && last && sorted.length >= 3 ? 2 : 1);
      for (const t of totals) dropped.push({ date, minutes: t, reason: t > 24 * 60 || last ? "month total" : "week total" });
      dayVals.set(date, sorted.slice(totals.length));
    } else if (vals[0]! > 24 * 60) {
      dropped.push({ date, minutes: vals[0]!, reason: sat ? "week total" : last ? "month total" : "more than a day" });
    } else if (sat || last) {
      pending.push({ date, minutes: vals[0]!, sat, last });
    } else {
      dayVals.set(date, [vals[0]!]);
    }
  }
  const sumWhere = (pred: (d: string) => boolean, except: string) => {
    let n = 0, count = 0;
    for (const [d, vs] of dayVals) if (d !== except && pred(d)) for (const v of vs) { n += v; count++; }
    return { n, count };
  };
  const matches = (value: number, sum: { n: number; count: number }) => sum.count > 0 && Math.abs(sum.n - value) <= 1 + sum.count;
  // Saturdays first, then last days
  pending.sort((a, b) => Number(b.sat) - Number(a.sat) || a.date.localeCompare(b.date));
  for (const p of pending) {
    if (p.sat && matches(p.minutes, sumWhere((d) => weekStart(d) === weekStart(p.date), p.date))) { dropped.push({ date: p.date, minutes: p.minutes, reason: "week total" }); continue; }
    if (p.last && matches(p.minutes, sumWhere((d) => d.slice(0, 7) === p.date.slice(0, 7), p.date))) { dropped.push({ date: p.date, minutes: p.minutes, reason: "month total" }); continue; }
    dayVals.set(p.date, [...(dayVals.get(p.date) ?? []), p.minutes]);
  }
  for (const [date, vs] of dayVals) for (const v of vs) out.set(date, (out.get(date) ?? 0) + v);
  return { days: [...out].map(([date, minutes]) => ({ date, minutes })).sort((a, b) => a.date.localeCompare(b.date)), dropped, month: key(year, month, 1).slice(0, 7) };
}

function yearFor(month: number, nowYear: number, nowMonth: number): number {
  // a month more than 6 ahead of now most likely means last year
  return month - nowMonth > 6 ? nowYear - 1 : nowYear;
}

/** Sunday–Saturday weeks, amount rounded to cents. */
export function computePayroll(input: { personId: string; name: string; logs: WorkLog[]; rate: number; currency?: string; from: string; to: string; expectedWeeklyHours?: number; now: Date }): Payroll {
  const inRange = input.logs.filter((l) => l.date >= input.from && l.date <= input.to);
  const dayMap = new Map<string, number>();
  for (const l of inRange) dayMap.set(l.date, (dayMap.get(l.date) ?? 0) + l.minutes);
  const days = [...dayMap].map(([date, minutes]) => ({ date, minutes })).sort((a, b) => a.date.localeCompare(b.date));
  const weekMap = new Map<string, number>();
  for (const d of days) { const ws = weekStart(d.date); weekMap.set(ws, (weekMap.get(ws) ?? 0) + d.minutes); }
  const money = (min: number) => Math.round((min / 60) * input.rate * 100) / 100;
  const weeks = [...weekMap].map(([start, minutes]) => ({ start, end: addDaysKey(start, 6), minutes, amount: money(minutes) })).sort((a, b) => a.start.localeCompare(b.start));
  const totalMinutes = days.reduce((n, d) => n + d.minutes, 0);
  return { personId: input.personId, name: input.name, from: input.from, to: input.to, rate: input.rate, currency: input.currency ?? "USD", days, weeks, totalMinutes, amount: money(totalMinutes), expectedWeeklyHours: input.expectedWeeklyHours, generatedAt: input.now.toISOString() };
}

/** Period keywords → [from, to] day keys in the viewer's zone. */
export function payrollRange(period: string | undefined, now: Date, tz: string): { from: string; to: string; label: string } {
  const today = dayKey(now, tz);
  const p = (period ?? "this week").toLowerCase().trim();
  if (p === "this week" || p === "week") { const ws = weekStart(today); return { from: ws, to: addDaysKey(ws, 6), label: "this week" }; }
  if (p === "last week") { const ws = addDaysKey(weekStart(today), -7); return { from: ws, to: addDaysKey(ws, 6), label: "last week" }; }
  if (p === "this month" || p === "month") { const z = toZoned(now, tz); return { from: key(z.year, z.month, 1), to: key(z.year, z.month, daysIn(z.year, z.month)), label: "this month" }; }
  if (p === "last month") { const z = toZoned(now, tz); const m = z.month === 1 ? 12 : z.month - 1; const y = z.month === 1 ? z.year - 1 : z.year; return { from: key(y, m, 1), to: key(y, m, daysIn(y, m)), label: "last month" }; }
  if (p === "all" || p === "all time" || p === "everything" || p === "total") return { from: "0000-01-01", to: "9999-12-31", label: "all time" };
  const mm = new RegExp(`^(${MONTH_RE})(?:\\s+(\\d{4}))?$`, "i").exec(p);
  if (mm) { const z = toZoned(now, tz); const m = MONTHS[mm[1]!.toLowerCase()]!; const y = mm[2] ? Number(mm[2]) : yearFor(m, z.year, z.month); return { from: key(y, m, 1), to: key(y, m, daysIn(y, m)), label: `${mm[1]} ${y}` }; }
  const range = /^(\d{4}-\d{2}-\d{2})\s*(?:to|-|–|through)\s*(\d{4}-\d{2}-\d{2})$/.exec(p);
  if (range) return { from: range[1]!, to: range[2]!, label: `${range[1]} to ${range[2]}` };
  const ws = weekStart(today);
  return { from: ws, to: addDaysKey(ws, 6), label: "this week" };
}

export function formatMoney(amount: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}
