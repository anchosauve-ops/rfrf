import { describe, it, expect } from "vitest";
import { parseChrono } from "../src/core/chrono";

const now = new Date("2026-09-03T14:00:00Z"); // Thursday 10:00 America/New_York
const tz = "America/New_York";
const p = (s: string) => parseChrono(s, { now, tz });

describe("chrono: day words", () => {
  it("tomorrow at 5 → 17:00 local tomorrow", () => {
    const r = p("tomorrow at 5");
    expect(r.start?.toISOString()).toBe("2026-09-04T21:00:00.000Z");
    expect(r.hasTime).toBe(true);
    expect(r.remainder).toBe("");
  });
  it("today defaults to 9am and is allDay", () => {
    const r = p("clean the garage today");
    expect(r.allDay).toBe(true);
    expect(r.start?.toISOString()).toBe("2026-09-03T13:00:00.000Z");
    expect(r.remainder).toBe("clean the garage");
  });
  it("tonight → 20:00", () => {
    expect(p("tonight").start?.toISOString()).toBe("2026-09-04T00:00:00.000Z");
  });
  it("day after tomorrow", () => {
    expect(p("day after tomorrow").start?.toISOString()).toBe("2026-09-05T13:00:00.000Z");
  });
});

describe("chrono: weekdays", () => {
  it("plain friday is the coming friday", () => expect(p("friday").start?.toISOString()).toBe("2026-09-04T13:00:00.000Z"));
  it("next friday skips the one this week", () => expect(p("next friday").start?.toISOString()).toBe("2026-09-11T13:00:00.000Z"));
  it("next monday is the coming monday (already next week)", () => expect(p("next monday").start?.toISOString()).toBe("2026-09-07T13:00:00.000Z"));
  it("by tue marks a deadline", () => {
    const r = p("by tue");
    expect(r.isDeadline).toBe(true);
    expect(r.start?.toISOString()).toBe("2026-09-08T13:00:00.000Z");
  });
});

describe("chrono: clock times", () => {
  it("at 9 is 9am (not 9pm)", () => expect(p("at 9").start?.toISOString()).toBe("2026-09-04T13:00:00.000Z")); // 9am passed → tomorrow
  it("at 3 is 3pm today", () => expect(p("at 3").start?.toISOString()).toBe("2026-09-03T19:00:00.000Z"));
  it("17:30 works", () => expect(p("17:30").start?.toISOString()).toBe("2026-09-03T21:30:00.000Z"));
  it("noon tomorrow", () => expect(p("noon tomorrow").start?.toISOString()).toBe("2026-09-04T16:00:00.000Z"));
  it("range 2-4pm produces end and duration", () => {
    const r = p("2-4pm");
    expect(r.start?.toISOString()).toBe("2026-09-03T18:00:00.000Z");
    expect(r.end?.toISOString()).toBe("2026-09-03T20:00:00.000Z");
    expect(r.durationMin).toBe(120);
  });
  it("from 12 to 1pm handles am/pm inference", () => {
    const r = p("lunch from 12 to 1pm");
    expect(r.start?.toISOString()).toBe("2026-09-03T16:00:00.000Z");
    expect(r.end?.toISOString()).toBe("2026-09-03T17:00:00.000Z");
    expect(r.remainder).toBe("lunch");
  });
});

describe("chrono: relative and durations", () => {
  it("in 2 hours is relative, not a duration", () => {
    const r = p("in 2 hours check the oven");
    expect(r.start?.toISOString()).toBe("2026-09-03T16:00:00.000Z");
    expect(r.durationMin).toBeUndefined();
    expect(r.remainder).toBe("check the oven");
  });
  it("for 45 min is a duration", () => {
    const r = p("meeting at 3pm for 45 min");
    expect(r.durationMin).toBe(45);
    expect(r.end?.toISOString()).toBe("2026-09-03T19:45:00.000Z");
  });
  it("(2h) shorthand", () => expect(p("write update (2h)").durationMin).toBe(120));
  it("in a couple of days", () => expect(p("in a couple of days").start?.toISOString()).toBe("2026-09-05T13:00:00.000Z"));
  it("in 30 minutes", () => expect(p("in 30 minutes").start?.toISOString()).toBe("2026-09-03T14:30:00.000Z"));
});

describe("chrono: dates", () => {
  it("sept 12th", () => expect(p("dentist sept 12th 10:30am").start?.toISOString()).toBe("2026-09-12T14:30:00.000Z"));
  it("12 september", () => expect(p("12 september").start?.toISOString()).toBe("2026-09-12T13:00:00.000Z"));
  it("rolls past dates into next year", () => expect(p("jan 5").start?.toISOString()).toBe("2027-01-05T14:00:00.000Z"));
  it("ISO date", () => expect(p("2026-10-01 14:00").start?.toISOString()).toBe("2026-10-01T18:00:00.000Z"));
  it("on the 1st → next month when passed", () => expect(p("pay rent on the 1st").start?.toISOString()).toBe("2026-10-01T13:00:00.000Z"));
  it("eod is a deadline at workday end", () => {
    const r = parseChrono("submit by eod", { now, tz, endOfDayMin: 17 * 60 });
    expect(r.isDeadline).toBe(true);
    expect(r.start?.toISOString()).toBe("2026-09-03T21:00:00.000Z");
  });
  it("eow → friday 5pm", () => expect(p("by eow").start?.toISOString()).toBe("2026-09-04T21:00:00.000Z"));
  it("this weekend → saturday", () => expect(p("this weekend").start?.toISOString()).toBe("2026-09-05T13:00:00.000Z"));
  it("next week → monday", () => expect(p("next week").start?.toISOString()).toBe("2026-09-07T13:00:00.000Z"));
});

describe("chrono: recurrence", () => {
  it("every weekday at 8am", () => {
    const r = p("every weekday at 8am journal");
    expect(r.recurrence).toEqual({ freq: "weekly", interval: 1, byWeekday: [1, 2, 3, 4, 5], time: "08:00" });
    expect(r.remainder).toBe("journal");
  });
  it("every other week on wed at 4pm", () => {
    expect(p("every other week on wed at 4pm").recurrence).toEqual({ freq: "weekly", interval: 2, byWeekday: [3], time: "16:00" });
  });
  it("every mon and thu", () => expect(p("every mon and thu").recurrence?.byWeekday).toEqual([1, 4]));
  it("daily / monthly", () => {
    expect(p("daily").recurrence?.freq).toBe("daily");
    expect(p("monthly").recurrence?.freq).toBe("monthly");
  });
});

describe("chrono: zones", () => {
  it("respects a different zone", () => {
    const r = parseChrono("tomorrow at 9am", { now, tz: "Asia/Tokyo" });
    // Tokyo is UTC+9; now is Sep 3 23:00 Tokyo → tomorrow = Sep 4 09:00 JST = Sep 4 00:00Z
    expect(r.start?.toISOString()).toBe("2026-09-04T00:00:00.000Z");
  });
  it("handles DST edge in March", () => {
    const r = parseChrono("tomorrow at 9am", { now: new Date("2026-03-07T15:00:00Z"), tz: "America/New_York" });
    expect(r.start?.toISOString()).toBe("2026-03-08T13:00:00.000Z"); // EDT begins Mar 8 → 9am = 13:00Z
  });
});
