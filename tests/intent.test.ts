import { describe, it, expect } from "vitest";
import { parseIntent } from "../src/core/intent";

const ctx = { now: new Date("2026-09-03T14:00:00Z"), tz: "America/New_York", workdayEndMin: 18 * 60 };
const P = (s: string) => parseIntent(s, ctx).intent;

describe("intent: tasks", () => {
  it("remind me to … by … → task with deadline", () => {
    const i = P("remind me to submit the report by friday eod");
    expect(i.type).toBe("create_task");
    if (i.type !== "create_task") return;
    expect(i.title).toBe("Submit the report");
    expect(i.due).toBe("2026-09-04T22:00:00.000Z");
    expect(i.pinnedStart).toBeUndefined();
  });
  it("call X at time → pinned task, social energy", () => {
    const i = P("call mom tomorrow at 5");
    expect(i).toMatchObject({ type: "create_task", title: "Call mom", energy: "social", pinnedStart: "2026-09-04T21:00:00.000Z" });
  });
  it("parses tags, project, priority, estimate", () => {
    const i = P("I need to renew my passport #admin +life !2 (40m)");
    expect(i).toMatchObject({ type: "create_task", title: "Renew my passport", tags: ["admin"], project: "life", priority: 2, estimateMin: 40, energy: "admin" });
  });
  it("recurring task rolls due to next occurrence", () => {
    const i = P("every weekday at 8am journal");
    expect(i.type).toBe("create_task");
    if (i.type !== "create_task") return;
    expect(i.recurrence?.byWeekday).toEqual([1, 2, 3, 4, 5]);
    expect(i.due).toBe("2026-09-04T12:00:00.000Z");
  });
  it("bare verb phrase is a task", () => expect(P("email the landlord").type).toBe("create_task"));
  it("deep-work words set energy", () => expect(P("write the investor update tomorrow")).toMatchObject({ energy: "deep" }));
});

describe("intent: events", () => {
  it("meeting with people", () => {
    const i = P("meeting with Sam and Priya next tuesday 3pm for 45 min");
    expect(i).toMatchObject({ type: "create_event", title: "Meeting with Sam and Priya", start: "2026-09-08T19:00:00.000Z", end: "2026-09-08T19:45:00.000Z", people: ["Sam", "Priya"] });
  });
  it("lunch with location", () => {
    const i = P("lunch with Dana friday from 12 to 1pm at Blue Bottle");
    expect(i).toMatchObject({ type: "create_event", location: "Blue Bottle", people: ["Dana"], start: "2026-09-04T16:00:00.000Z", end: "2026-09-04T17:00:00.000Z" });
  });
  it("block time for deep work", () => {
    const i = P("block 9-11am tomorrow for deep work");
    expect(i).toMatchObject({ type: "create_event", start: "2026-09-04T13:00:00.000Z", end: "2026-09-04T15:00:00.000Z" });
  });
  it("dentist appointment", () => expect(P("dentist sept 12th 10:30am")).toMatchObject({ type: "create_event", title: "Dentist" }));
});

describe("intent: commands", () => {
  it("plan my day / plan tomorrow", () => {
    expect(P("plan my day")).toMatchObject({ type: "plan_day", date: "2026-09-03T13:00:00.000Z" });
    expect(P("plan tomorrow")).toMatchObject({ type: "plan_day", date: "2026-09-04T13:00:00.000Z" });
    expect(P("what should I work on")).toMatchObject({ type: "plan_day" });
  });
  it("briefs", () => {
    expect(P("morning brief")).toMatchObject({ type: "brief", kind: "morning" });
    expect(P("what's on today")).toMatchObject({ type: "brief", kind: "morning" });
    expect(P("evening review")).toMatchObject({ type: "brief", kind: "evening" });
    expect(P("weekly retro")).toMatchObject({ type: "brief", kind: "weekly" });
  });
  it("lists", () => {
    expect(P("what's overdue")).toMatchObject({ type: "list_tasks", filter: "overdue" });
    expect(P("show my tasks")).toMatchObject({ type: "list_tasks", filter: "all" });
    expect(P("today's tasks")).toMatchObject({ type: "list_tasks", filter: "today" });
  });
  it("complete / drop / move", () => {
    expect(P("done with the report")).toMatchObject({ type: "complete_task", query: "report" });
    expect(P("finished pay contractor invoice")).toMatchObject({ type: "complete_task", query: "pay contractor invoice" });
    expect(P("drop the newsletter task")).toMatchObject({ type: "drop_task", query: "newsletter" });
    expect(P("move dentist to next week")).toMatchObject({ type: "reschedule_task", query: "dentist", when: "2026-09-07T13:00:00.000Z", allDay: true });
  });
  it("focus", () => {
    expect(P("focus for 50 on the essay")).toMatchObject({ type: "start_focus", minutes: 50, query: "the essay" });
    expect(P("start focus")).toMatchObject({ type: "start_focus", minutes: 25 });
  });
});

describe("intent: memory and people", () => {
  it("remember that … → preference", () => expect(P("remember that I prefer deep work before noon")).toMatchObject({ type: "remember", kind: "preference", text: "I prefer deep work before noon" }));
  it("remember to … is a task, not a memory", () => expect(P("remember to buy milk").type).toBe("create_task"));
  it("goal phrasing becomes a goal, not just a memory", () => {
    const r = parseIntent("my goal this quarter is to ship v1", ctx);
    expect(r.intent).toMatchObject({ type: "create_goal", horizon: "quarter" });
    expect((r.intent as { title: string }).title).toMatch(/ship v1/i);
    expect(parseIntent("goal: run a marathon by next april", ctx).intent).toMatchObject({ type: "create_goal", horizon: "year" });
    expect(parseIntent("convene the council", ctx).intent.type).toBe("council");
    expect(parseIntent("what's at risk", ctx).intent.type).toBe("futures");
    expect(parseIntent("what have you learned about me", ctx).intent.type).toBe("mirror");
    expect(parseIntent("undo that", ctx).intent.type).toBe("undo");
  });
  it("recall and forget", () => {
    expect(P("what do you know about my goals")).toMatchObject({ type: "recall", query: "my goals" });
    expect(P("forget that I like tea")).toMatchObject({ type: "forget", query: "i like tea" });
  });
  it("met X → person with relation and cadence", () => {
    expect(P("met Priya, she's a colleague from design, every 2 weeks")).toMatchObject({ type: "create_person", name: "Priya", relation: "colleague", cadenceDays: 14 });
  });
  it("talked to X → log contact", () => expect(P("talked to Sam")).toMatchObject({ type: "log_contact", name: "Sam" }));
  it("who should I reach out to", () => expect(P("who should I reach out to").type).toBe("people_touch"));
});

describe("intent: preferences & fallback", () => {
  it("name keeps its case", () => expect(P("my name is Will")).toMatchObject({ type: "set_preference", key: "name", value: "Will" }));
  it("timezone", () => expect(P("timezone Europe/Berlin")).toMatchObject({ type: "set_preference", key: "timezone", value: "Europe/Berlin" }));
  it("chat fallback has low confidence", () => {
    const r = parseIntent("hello there how are you", ctx);
    expect(r.intent.type).toBe("chat");
    expect(r.confidence).toBeLessThan(0.5);
  });
});
