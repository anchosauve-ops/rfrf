import type { RRule } from "./types.js";
import { toZoned, fromZoned, daysInMonth } from "./tz.js";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function parseTime(t?: string): { hour: number; minute: number } {
  if (!t) return { hour: 9, minute: 0 };
  const [h, m] = t.split(":").map(Number);
  return { hour: h ?? 9, minute: m ?? 0 };
}

/**
 * Next occurrence strictly after `after`, in the user's zone.
 * Returns null when the rule has ended.
 */
export function nextOccurrence(rule: RRule, after: Date, tz: string): Date | null {
  const interval = Math.max(1, rule.interval ?? 1);
  const { hour, minute } = parseTime(rule.time);
  const until = rule.until ? new Date(rule.until) : null;
  const a = toZoned(after, tz);

  const candidateOn = (y: number, m: number, d: number) => fromZoned({ year: y, month: m, day: d, hour, minute }, tz);

  let result: Date | null = null;

  if (rule.freq === "daily") {
    for (let i = 0; i <= 400 && !result; i++) {
      const c = candidateOn(a.year, a.month, a.day + i);
      if (c > after && i % interval === 0) result = c;
    }
  } else if (rule.freq === "weekly") {
    const days = rule.byWeekday && rule.byWeekday.length ? [...rule.byWeekday].sort() : [a.weekday];
    for (let i = 0; i <= 7 * 53 && !result; i++) {
      const c = candidateOn(a.year, a.month, a.day + i);
      const wd = toZoned(c, tz).weekday;
      const weekIndex = Math.floor(i / 7);
      if (c > after && days.includes(wd) && weekIndex % interval === 0) result = c;
    }
  } else if (rule.freq === "monthly") {
    const dom = rule.byMonthDay ?? a.day;
    for (let i = 0; i <= 36 && !result; i++) {
      const m0 = a.month - 1 + i;
      const y = a.year + Math.floor(m0 / 12);
      const m = (m0 % 12) + 1;
      const d = Math.min(dom, daysInMonth(y, m));
      const c = candidateOn(y, m, d);
      if (c > after && i % interval === 0) result = c;
    }
  } else if (rule.freq === "yearly") {
    for (let i = 0; i <= 5 && !result; i++) {
      const c = candidateOn(a.year + i, a.month, Math.min(a.day, daysInMonth(a.year + i, a.month)));
      if (c > after && i % interval === 0) result = c;
    }
  }

  if (result && until && result > until) return null;
  return result;
}

export function describeRule(rule: RRule): string {
  const interval = rule.interval ?? 1;
  const time = rule.time ? ` at ${rule.time}` : "";
  const every = (unit: string) => (interval === 1 ? `every ${unit}` : `every ${interval} ${unit}s`);
  switch (rule.freq) {
    case "daily":
      return `${every("day")}${time}`;
    case "weekly": {
      const days = rule.byWeekday ?? [];
      if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))) return `every weekday${time}`;
      if (days.length === 0) return `${every("week")}${time}`;
      const names = [...days].sort().map((d) => DAY_NAMES[d] ?? "?");
      return `${interval === 1 ? "every" : `every ${interval} weeks on`} ${names.join(", ")}${time}`;
    }
    case "monthly":
      return `${every("month")}${rule.byMonthDay ? ` on the ${ordinal(rule.byMonthDay)}` : ""}${time}`;
    case "yearly":
      return `${every("year")}${time}`;
  }
}

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}
