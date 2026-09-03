import { describe, it, expect } from "vitest";
import { nextOccurrence, describeRule } from "../src/core/rrule";

const tz = "America/New_York";
const after = new Date("2026-09-03T14:00:00Z"); // Thu 10:00

describe("rrule", () => {
  it("daily at 08:00 → tomorrow 8am when today's passed", () => {
    expect(nextOccurrence({ freq: "daily", time: "08:00" }, after, tz)?.toISOString()).toBe("2026-09-04T12:00:00.000Z");
  });
  it("daily at 15:00 → today", () => {
    expect(nextOccurrence({ freq: "daily", time: "15:00" }, after, tz)?.toISOString()).toBe("2026-09-03T19:00:00.000Z");
  });
  it("weekdays skip the weekend", () => {
    const fri = new Date("2026-09-04T20:00:00Z");
    expect(nextOccurrence({ freq: "weekly", byWeekday: [1, 2, 3, 4, 5], time: "08:00" }, fri, tz)?.toISOString()).toBe("2026-09-07T12:00:00.000Z");
  });
  it("every other week on wednesday", () => {
    expect(nextOccurrence({ freq: "weekly", interval: 2, byWeekday: [3], time: "16:00" }, after, tz)?.toISOString()).toBe("2026-09-09T20:00:00.000Z");
  });
  it("monthly on the 31st clamps to short months", () => {
    expect(nextOccurrence({ freq: "monthly", byMonthDay: 31, time: "09:00" }, new Date("2026-09-01T00:00:00Z"), tz)?.toISOString()).toBe("2026-09-30T13:00:00.000Z");
  });
  it("respects until", () => {
    expect(nextOccurrence({ freq: "daily", time: "08:00", until: "2026-09-03T00:00:00Z" }, after, tz)).toBeNull();
  });
  it("describes rules", () => {
    expect(describeRule({ freq: "weekly", byWeekday: [1, 2, 3, 4, 5], time: "08:00" })).toBe("every weekday at 08:00");
    expect(describeRule({ freq: "weekly", interval: 2, byWeekday: [3] })).toBe("every 2 weeks on Wednesday");
    expect(describeRule({ freq: "monthly", byMonthDay: 1 })).toBe("every month on the 1st");
  });
});
