/**
 * Chrono — Kairos' natural-language time parser.
 *
 * Deterministic, zone-aware, dependency-free. It turns human phrasing like
 * "next tue at 3 for 45 min", "every weekday 8am", "by eod", "in 2 hours",
 * "sept 12th", "this weekend" into concrete instants, durations and rules,
 * and hands back the sentence with the time language removed so the rest of
 * the system can use it as a title.
 */
import type { RRule } from "./types.js";
import { toZoned, fromZoned, addMinutes, setTime } from "./tz.js";

export interface ChronoOptions {
  now: Date;
  tz: string;
  /** Hour used when a date is given without a time (default 9). */
  defaultHour?: number;
  /** Minutes-since-midnight for "end of day" (default 18:00). */
  endOfDayMin?: number;
}

export interface ChronoResult {
  start?: Date;
  end?: Date;
  /** A date was found but no clock time. */
  allDay: boolean;
  hasDate: boolean;
  hasTime: boolean;
  /** "by"/"before"/"due" framed the time as a deadline. */
  isDeadline: boolean;
  durationMin?: number;
  recurrence?: RRule;
  remainder: string;
  matched: string[];
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};
const WEEKDAY_RE = "sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat";

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_RE = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec";

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fortyfive: 45, sixty: 60,
  couple: 2, few: 3, half: 0.5,
};

function num(s: string | undefined): number {
  if (!s) return 1;
  const t = s.trim().toLowerCase().replace(/\s+/g, "");
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  return NUMBER_WORDS[t] ?? 1;
}

interface Work {
  text: string;
  matched: string[];
  dayBase?: Date; // start-of-day anchor
  hour?: number;
  minute?: number;
  endHour?: number;
  endMinute?: number;
  durationMin?: number;
  recurrence?: RRule;
  relativeInstant?: Date;
  isDeadline: boolean;
  weekday?: number;
}

function take(w: Work, re: RegExp, fn: (m: RegExpExecArray) => void): boolean {
  const m = re.exec(w.text);
  if (!m) return false;
  fn(m);
  w.matched.push(m[0].trim());
  w.text = (w.text.slice(0, m.index) + " " + w.text.slice(m.index + m[0].length)).replace(/\s{2,}/g, " ");
  return true;
}

function daysInMonthLocal(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function toHour(hRaw: string, mRaw: string | undefined, ampm: string | undefined): { hour: number; minute: number } | null {
  let hour = Number(hRaw);
  const minute = mRaw ? Number(mRaw) : 0;
  if (Number.isNaN(hour) || hour > 24 || minute > 59) return null;
  const ap = ampm?.replace(/\./g, "").toLowerCase();
  if (ap === "pm" && hour < 12) hour += 12;
  if (ap === "am" && hour === 12) hour = 0;
  if (!ap && !mRaw && hour >= 1 && hour <= 6) hour += 12; // "at 5" → 17:00
  if (hour === 24) hour = 0;
  return { hour, minute };
}

export function parseChrono(input: string, opts: ChronoOptions): ChronoResult {
  const { now, tz } = opts;
  const defaultHour = opts.defaultHour ?? 9;
  const endOfDayMin = opts.endOfDayMin ?? 18 * 60;
  const nowP = toZoned(now, tz);
  const today = fromZoned({ year: nowP.year, month: nowP.month, day: nowP.day }, tz);
  const dayAt = (offset: number) => fromZoned({ year: nowP.year, month: nowP.month, day: nowP.day + offset }, tz);

  const w: Work = { text: ` ${input} `, matched: [], isDeadline: false };

  // ---------- 1. Recurrence ----------
  void (take(w, /\b(every|each)\s+(other\s+)?(\d+\s+)?(day|weekday|week|month|year|(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*(?:\s*(?:,|and|&)\s*(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*)*)s?\b/i, (m) => {
    const interval = m[2] ? 2 : m[3] ? Number(m[3]) : 1;
    const unit = (m[4] ?? "day").toLowerCase();
    if (unit === "day") w.recurrence = { freq: "daily", interval };
    else if (unit === "weekday") w.recurrence = { freq: "weekly", interval, byWeekday: [1, 2, 3, 4, 5] };
    else if (unit === "week") w.recurrence = { freq: "weekly", interval };
    else if (unit === "month") w.recurrence = { freq: "monthly", interval };
    else if (unit === "year") w.recurrence = { freq: "yearly", interval };
    else {
      const days = unit.split(/\s*(?:,|and|&)\s*/).map((d) => WEEKDAYS[d.slice(0, 3)]).filter((d): d is number => d !== undefined);
      w.recurrence = { freq: "weekly", interval, byWeekday: [...new Set(days)].sort() };
    }
  }) || take(w, /\b(daily|weekly|monthly|yearly|annually|weekdays)\b/i, (m) => {
    const u = (m[1] ?? "").toLowerCase();
    w.recurrence =
      u === "daily" ? { freq: "daily" }
      : u === "weekly" ? { freq: "weekly" }
      : u === "monthly" ? { freq: "monthly" }
      : u === "weekdays" ? { freq: "weekly", byWeekday: [1, 2, 3, 4, 5] }
      : { freq: "yearly" };
  }));

  // ---------- 3. Relative "in N units" ----------
  void (take(w, /\bin\s+(?:about\s+|around\s+)?(an?\s+couple\s+of|a\s+few|an?|\d+(?:\.\d+)?|[a-z]+)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?|months?)\b/i, (m) => {
    const q = (m[1] ?? "").toLowerCase().replace(/^an?\s+couple\s+of$/, "couple").replace(/^a\s+few$/, "few");
    const n = num(q);
    const unit = (m[2] ?? "").toLowerCase();
    if (unit.startsWith("min")) w.relativeInstant = addMinutes(now, n);
    else if (unit.startsWith("h")) w.relativeInstant = addMinutes(now, n * 60);
    else if (unit.startsWith("d")) w.dayBase = dayAt(Math.round(n));
    else if (unit.startsWith("w")) w.dayBase = dayAt(Math.round(n * 7));
    else if (unit.startsWith("mo")) {
      w.dayBase = fromZoned({ year: nowP.year, month: nowP.month + Math.round(n), day: nowP.day }, tz);
    }
  }));

  // ---------- 2. Duration ----------
  // "for 45 min", "for an hour", "for 1.5 hours", "for half an hour"
  void (take(w, /\bfor\s+(half\s+an?|an?|\d+(?:\.\d+)?|[a-z]+)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/i, (m) => {
    const q = (m[1] ?? "").toLowerCase();
    const n = q.startsWith("half") ? 0.5 : num(q);
    const unit = (m[2] ?? "").toLowerCase();
    w.durationMin = Math.round(unit.startsWith("h") ? n * 60 : n);
  }) ||
  // "1h30", "1h 30m", "2h", "45m", "~45min", "(30 min)"
  take(w, /[(~]?\b(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours)(?:\s*(\d+)\s*(m|min|mins)?)?\b\)?/i, (m) => {
    w.durationMin = Math.round(Number(m[1]) * 60 + (m[3] ? Number(m[3]) : 0));
  }) ||
  take(w, /[(~]?\b(\d+)\s*(m|min|mins|minutes?)\b\)?/i, (m) => {
    w.durationMin = Number(m[1]);
  }));

  // ---------- 4. Explicit dates ----------
  void (take(w, /\b(\d{4})-(\d{2})-(\d{2})\b/, (m) => {
    w.dayBase = fromZoned({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }, tz);
  }) ||
  take(w, new RegExp(`\\b(?:on\\s+|by\\s+|due\\s+)?(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "i"), (m) => {
    if (/^(by|due)\s/i.test(m[0])) w.isDeadline = true;
    const month = MONTHS[(m[1] ?? "").toLowerCase()] ?? nowP.month;
    const day = Number(m[2]);
    let year = m[3] ? Number(m[3]) : nowP.year;
    if (!m[3] && (month < nowP.month || (month === nowP.month && day < nowP.day))) year += 1;
    w.dayBase = fromZoned({ year, month, day }, tz);
  }) ||
  take(w, new RegExp(`\\b(?:on\\s+|by\\s+|due\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_RE})\\b(?:,?\\s+(\\d{4}))?`, "i"), (m) => {
    if (/^(by|due)\s/i.test(m[0])) w.isDeadline = true;
    const day = Number(m[1]);
    const month = MONTHS[(m[2] ?? "").toLowerCase()] ?? nowP.month;
    let year = m[3] ? Number(m[3]) : nowP.year;
    if (!m[3] && (month < nowP.month || (month === nowP.month && day < nowP.day))) year += 1;
    w.dayBase = fromZoned({ year, month, day }, tz);
  }) ||
  take(w, /\b(?:on\s+|by\s+|due\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/, (m) => {
    if (/^(by|due)\s/i.test(m[0])) w.isDeadline = true;
    const month = Number(m[1]);
    const day = Number(m[2]);
    let year = m[3] ? Number(m[3]) : nowP.year;
    if (m[3] && year < 100) year += 2000;
    if (month < 1 || month > 12 || day < 1 || day > 31) return;
    if (!m[3] && (month < nowP.month || (month === nowP.month && day < nowP.day))) year += 1;
    w.dayBase = fromZoned({ year, month, day }, tz);
  }) ||
  take(w, new RegExp(`\\b(?:(next|this|in|by|until|before)\\s+)?(${MONTH_RE})\\b(?!\\s*\\d)`, "i"), (m) => {
    const mod = (m[1] ?? "").toLowerCase();
    if (["by", "until", "before"].includes(mod)) w.isDeadline = true;
    const month = MONTHS[(m[2] ?? "").toLowerCase()];
    if (!month) return;
    let year = nowP.year;
    if (month < nowP.month || (month === nowP.month && mod === "next")) year += 1;
    if (mod === "next" && month > nowP.month) year += 0; // "next april" said in September means the coming April
    const day = w.isDeadline ? daysInMonthLocal(year, month) : 1;
    w.dayBase = fromZoned({ year, month, day }, tz);
  }) ||
  take(w, /\b(?:on\s+|by\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b/i, (m) => {
    if (/^by\s/i.test(m[0])) w.isDeadline = true;
    const day = Number(m[1]);
    const month = day < nowP.day ? nowP.month + 1 : nowP.month;
    w.dayBase = fromZoned({ year: nowP.year, month, day }, tz);
  }));

  // ---------- 5. Day words ----------
  void (take(w, /\b(?:by\s+|before\s+|until\s+|due\s+)?(day\s+after\s+tomorrow|tomorrow|tmrw|tmr|today|tonight|yesterday)\b/i, (m) => {
    if (/^(by|before|until|due)\s/i.test(m[0])) w.isDeadline = true;
    const word = (m[1] ?? "").toLowerCase().replace(/\s+/g, " ");
    if (word.startsWith("day after")) w.dayBase = dayAt(2);
    else if (word.startsWith("tom") || word.startsWith("tm")) w.dayBase = dayAt(1);
    else if (word === "yesterday") w.dayBase = dayAt(-1);
    else if (word === "tonight") { w.dayBase = today; if (w.hour === undefined) { w.hour = 20; w.minute = 0; } }
    else w.dayBase = today;
  }));
  void (take(w, /\b(?:by\s+|before\s+)?(?:the\s+)?(end\s+of\s+(?:the\s+)?(?:day|week|month)|eod|eow|eom|cob)\b/i, (m) => {
    w.isDeadline = true;
    const word = (m[1] ?? "").toLowerCase().replace(/\s+/g, " ");
    if (word === "eod" || word === "cob" || word.endsWith("day")) {
      w.dayBase ??= today;
      w.hour = Math.floor(endOfDayMin / 60);
      w.minute = endOfDayMin % 60;
    } else if (word === "eow" || word.endsWith("week")) {
      const daysToFri = (5 - nowP.weekday + 7) % 7;
      w.dayBase = dayAt(daysToFri === 0 && nowP.hour >= 17 ? 7 : daysToFri);
      w.hour = 17; w.minute = 0;
    } else {
      const last = fromZoned({ year: nowP.year, month: nowP.month + 1, day: 0 }, tz);
      w.dayBase = last;
      w.hour = 17; w.minute = 0;
    }
  }));
  void (take(w, /\b(this|next)\s+(week|month|weekend)\b/i, (m) => {
    const which = (m[1] ?? "").toLowerCase();
    const unit = (m[2] ?? "").toLowerCase();
    if (unit === "weekend") {
      const toSat = (6 - nowP.weekday + 7) % 7;
      w.dayBase = dayAt(which === "next" ? toSat + 7 : toSat === 0 && nowP.weekday === 6 ? 0 : toSat);
    } else if (unit === "week") {
      const toMon = (1 - nowP.weekday + 7) % 7 || 7;
      w.dayBase = dayAt(which === "next" ? toMon : 0);
    } else {
      w.dayBase = fromZoned({ year: nowP.year, month: nowP.month + (which === "next" ? 1 : 0), day: which === "next" ? 1 : nowP.day }, tz);
    }
  }));
  void (take(w, /\b(this|in\s+the)\s+(morning|afternoon|evening)\b|\b(at\s+)?(night|noon|midday|midnight)\b/i, (m) => {
    const word = (m[2] ?? m[4] ?? "").toLowerCase();
    w.dayBase ??= today;
    if (w.hour !== undefined && !["noon", "midday", "midnight"].includes(word)) return;
    const map: Record<string, number> = { morning: 9, afternoon: 14, evening: 18, night: 20, noon: 12, midday: 12, midnight: 0 };
    w.hour = map[word] ?? defaultHour;
    w.minute = 0;
  }));

  // ---------- 6. Weekdays ----------
  void (take(w, new RegExp(`\\b(?:(next|this|on|by|before|until|due)\\s+)?(${WEEKDAY_RE})\\b`, "i"), (m) => {
    const mod = (m[1] ?? "").toLowerCase();
    if (["by", "before", "until", "due"].includes(mod)) w.isDeadline = true;
    const wd = WEEKDAYS[(m[2] ?? "").toLowerCase()] ?? nowP.weekday;
    w.weekday = wd;
    let delta = (wd - nowP.weekday + 7) % 7;
    if (mod === "next") {
      if (delta === 0) delta = 7;
      // "next X" means the X of next week when the coming X is still this week
      const daysLeftThisWeek = (7 - nowP.weekday) % 7; // days until Sunday
      if (delta <= daysLeftThisWeek && delta !== 7) delta += 7;
    } else if (delta === 0 && !w.recurrence) {
      // plain "friday" said on a Friday: today if the day isn't over
      if (nowP.hour >= 20) delta = 7;
    }
    if (!w.recurrence) w.dayBase = dayAt(delta);
    else if (!w.recurrence.byWeekday && w.recurrence.freq === "weekly") w.recurrence.byWeekday = [wd];
  }));

  // ---------- 7. Time ranges & clock times ----------
  // "from 2 to 4pm", "2-4pm", "3:30pm - 5pm", "between 9 and 10"
  void (take(w, /\b(?:from\s+|between\s+)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:-|–|to|until|till|and)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i, (m) => {
    const endT = toHour(m[4] ?? "0", m[5], m[6]);
    const startT = toHour(m[1] ?? "0", m[2], m[3] ?? m[6]);
    if (!startT || !endT) return;
    if (!m[3] && m[6] && startT.hour > endT.hour) startT.hour -= 12;
    w.hour = startT.hour; w.minute = startT.minute;
    w.endHour = endT.hour; w.endMinute = endT.minute;
  }) ||
  take(w, /\b(?:at|@|by|before|until|till|due|around|circa|~)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|o'?clock)?(?![\d/:-])\b/i, (m) => {
    if (/^(by|before|until|till|due)/i.test(m[0])) w.isDeadline = true;
    const t = toHour(m[1] ?? "0", m[2], m[3]?.startsWith("o") ? undefined : m[3]);
    if (!t) return;
    w.hour = t.hour; w.minute = t.minute;
  }) ||
  take(w, /\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?\b/i, (m) => {
    const t = toHour(m[1] ?? "0", m[2], m[3]);
    if (!t) return;
    w.hour = t.hour; w.minute = t.minute;
  }) ||
  take(w, /\b(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)\b/i, (m) => {
    const t = toHour(m[1] ?? "0", undefined, m[2]);
    if (!t) return;
    w.hour = t.hour; w.minute = t.minute;
  }));

  // ---------- Assemble ----------
  let start: Date | undefined;
  let end: Date | undefined;
  const hasTime = w.hour !== undefined || w.relativeInstant !== undefined;
  const hasDate = w.dayBase !== undefined || w.relativeInstant !== undefined;

  if (w.relativeInstant) {
    start = w.relativeInstant;
  } else if (w.dayBase && w.hour !== undefined) {
    start = setTime(w.dayBase, w.hour, w.minute ?? 0, tz);
  } else if (w.dayBase) {
    start = setTime(w.dayBase, defaultHour, 0, tz);
  } else if (w.hour !== undefined) {
    start = setTime(today, w.hour, w.minute ?? 0, tz);
    if (start <= now && !w.recurrence) start = setTime(dayAt(1), w.hour, w.minute ?? 0, tz);
  }

  if (start && w.endHour !== undefined) {
    end = setTime(start, w.endHour, w.endMinute ?? 0, tz);
    if (end <= start) end = addMinutes(end, 24 * 60);
    w.durationMin ??= Math.round((end.getTime() - start.getTime()) / 60000);
  } else if (start && w.durationMin) {
    end = addMinutes(start, w.durationMin);
  }

  if (w.recurrence && w.hour !== undefined) {
    w.recurrence.time = `${String(w.hour).padStart(2, "0")}:${String(w.minute ?? 0).padStart(2, "0")}`;
  }

  const remainder = w.text
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/^(?:at|on|by|in|for|from|to|until|till|due|around|the|and|,|-|–)\s+/i, "")
    .replace(/\s+(?:at|on|by|in|for|from|to|until|till|due|around|the|and|,|-|–)$/i, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/[,\s]+$/, "")
    .trim();

  return {
    start,
    end,
    allDay: hasDate && !hasTime,
    hasDate,
    hasTime,
    isDeadline: w.isDeadline,
    durationMin: w.durationMin,
    recurrence: w.recurrence,
    remainder,
    matched: w.matched,
  };
}
