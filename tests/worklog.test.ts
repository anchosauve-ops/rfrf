import { describe, it, expect, beforeAll } from "vitest";
import { parseWorklogText, computePayroll, payrollRange, parseHM, fmtHM, weekStart, parseIntent, type WorkLog } from "../src/core/index.js";
import { createApp } from "../src/server/app.js";

const now = new Date("2026-09-04T20:41:00Z"); // Fri Sep 4, 4:41 pm New York
const tz = "America/New_York";

// The actual Timeproof pages from the screenshots, as select-all text would read.
const AUGUST = `Erica Mae Lasia Dela Cruz's Timeproof
August 2026
Sun Mon Tue Wed Thu Fri Sat
26 27 28 29 30 31 1
2 3 4 5 6 7 8
9 10 11 12 13 14 15
16 17 18 19 20 21 22
23 24 25 26 01:40 27 05:31 28 00:54 29 08:05
30 01:28 31 07:04 16:39 1 07:31 2 09:10 3 06:55 4 5 32:11
Day Total (click to view screenshots) Week Total Month Total`;
const SEPTEMBER = `September 2026
Sun Mon Tue Wed Thu Fri Sat
30 01:28 31 07:04 16:39 1 07:31 2 09:10 3 06:55 4 5 32:11
6 7 8 9 10 11 12
13 14 15 16 17 18 19
20 21 22 23 24 25 26
27 28 29 30 23:37 1 2 3
4 5 6 7 8 9 10`;

describe("worklog parsing", () => {
  it("parses HH:MM, hours/minutes and minute forms", () => {
    expect(parseHM("07:04")).toBe(424);
    expect(parseHM("7h 4m")).toBe(424);
    expect(parseHM("1.5h")).toBe(90);
    expect(parseHM("45m")).toBe(45);
    expect(fmtHM(424)).toBe("07:04");
  });
  it("parses explicit dated lines in several shapes", () => {
    const r = parseWorklogText("Aug 31 07:04\n2026-09-01 7:31\n9/2 9h 10m\n3 Sep 06:55", { now, tz });
    expect(r.days).toEqual([
      { date: "2026-08-31", minutes: 424 },
      { date: "2026-09-01", minutes: 451 },
      { date: "2026-09-02", minutes: 550 },
      { date: "2026-09-03", minutes: 415 },
    ]);
  });
  it("reads a copied Timeproof month and drops week and month totals", () => {
    const r = parseWorklogText(AUGUST, { now, tz });
    expect(r.month).toBe("2026-08");
    expect(r.days).toEqual([
      { date: "2026-08-26", minutes: 100 },
      { date: "2026-08-27", minutes: 331 },
      { date: "2026-08-28", minutes: 54 },
      { date: "2026-08-30", minutes: 88 },
      { date: "2026-08-31", minutes: 424 },
      { date: "2026-09-01", minutes: 451 },
      { date: "2026-09-02", minutes: 550 },
      { date: "2026-09-03", minutes: 415 },
    ]);
    const reasons = r.dropped.map((d) => `${d.date}:${d.reason}`);
    expect(reasons).toContain("2026-08-29:week total");
    expect(reasons).toContain("2026-08-31:month total");
    expect(reasons).toContain("2026-09-05:week total");
  });
  it("september view yields the same September days and drops its month total", () => {
    const r = parseWorklogText(SEPTEMBER, { now, tz });
    expect(r.days.filter((d) => d.date.startsWith("2026-09")).map((d) => d.minutes)).toEqual([451, 550, 415]);
    expect(r.dropped.some((d) => d.date === "2026-09-30" && d.reason === "month total")).toBe(true);
    // the trailing August days in this view still parse
    expect(r.days.find((d) => d.date === "2026-08-31")?.minutes).toBe(424);
  });
});

describe("payroll", () => {
  const logs: WorkLog[] = [
    ["2026-08-26", 100], ["2026-08-27", 331], ["2026-08-28", 54], ["2026-08-30", 88], ["2026-08-31", 424], ["2026-09-01", 451], ["2026-09-02", 550], ["2026-09-03", 415],
  ].map(([date, minutes], i) => ({ id: `w${i}`, personId: "p", date: date as string, minutes: minutes as number, source: "timeproof", importedAt: "" }));

  it("computes Sunday–Saturday weeks and cents at $3.50/h (Erica's real numbers)", () => {
    const all = computePayroll({ personId: "p", name: "Erica", logs, rate: 3.5, from: "0000-01-01", to: "9999-12-31", now });
    expect(fmtHM(all.totalMinutes)).toBe("40:13");
    expect(all.amount).toBe(140.76);
    expect(all.weeks.map((w) => [w.start, fmtHM(w.minutes), w.amount])).toEqual([
      ["2026-08-23", "08:05", 28.29],
      ["2026-08-30", "32:08", 112.47],
    ]);
    const aug = computePayroll({ personId: "p", name: "Erica", logs, rate: 3.5, from: "2026-08-01", to: "2026-08-31", now });
    expect(fmtHM(aug.totalMinutes)).toBe("16:37");
    expect(aug.amount).toBe(58.16);
  });
  it("resolves period words in the viewer's zone", () => {
    expect(payrollRange("this week", now, tz)).toMatchObject({ from: "2026-08-30", to: "2026-09-05" });
    expect(payrollRange("last week", now, tz)).toMatchObject({ from: "2026-08-23", to: "2026-08-29" });
    expect(payrollRange("august", now, tz)).toMatchObject({ from: "2026-08-01", to: "2026-08-31" });
    expect(payrollRange("this month", now, tz)).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
    expect(weekStart("2026-09-04")).toBe("2026-08-30");
  });
  it("intents: rate, log, import, payroll, team", () => {
    const ctx = { now, tz };
    expect(parseIntent("Erica's rate is 3.50/hr", ctx).intent).toMatchObject({ type: "set_rate", name: "Erica", rate: 3.5 });
    expect(parseIntent("Erica worked 7:04 on aug 31", ctx).intent).toMatchObject({ type: "log_work", name: "Erica" });
    expect(parseIntent("import timeproof for Erica: Aug 31 07:04", ctx).intent).toMatchObject({ type: "import_worklog", name: "Erica" });
    expect(parseIntent("payroll for Erica this month", ctx).intent).toMatchObject({ type: "payroll", name: "Erica", period: "this month" });
    expect(parseIntent("what do I owe Erica", ctx).intent).toMatchObject({ type: "payroll", name: "Erica" });
    expect(parseIntent("team", ctx).intent.type).toBe("team");
  });
});

describe("team endpoints", () => {
  const ctx = createApp({ now: () => now, webDir: "/nonexistent", log: false });
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await ctx.app.request(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  beforeAll(() => ctx.repo.setPrefs({ timezone: tz, name: "Will", onboarded: true }));

  it("sets a rate by talking, imports a pasted month, and answers payroll", async () => {
    const r1 = await call("POST", "/api/agent/sync", { message: "Erica's rate is 3.50/hr" });
    expect(r1.body.text).toMatch(/\$3\.50\/h/);
    const r2 = await call("POST", "/api/agent/sync", { message: `import timeproof for Erica:\n${AUGUST}` });
    expect(r2.body.text).toMatch(/Imported 8 days/);
    expect(r2.body.text).toMatch(/skipped 3 totals/);
    const r3 = await call("POST", "/api/agent/sync", { message: "payroll for Erica all time" });
    expect(r3.body.text).toMatch(/40:13 at \$3\.50\/h = \$140\.76/);
    expect(r3.body.cards[0].type).toBe("payroll");
    const r4 = await call("POST", "/api/agent/sync", { message: "what do I owe Erica this week" });
    expect(r4.body.text).toMatch(/32:08.*\$112\.47/);
    const team = (await call("GET", "/api/team")).body;
    expect(team[0].person.name).toBe("Erica");
    expect(team[0].week.amount).toBe(112.47);
  });
  it("re-importing is idempotent and corrections update in place", async () => {
    const p = ctx.repo.findPerson("Erica")!;
    const again = await call("POST", "/api/worklog/import", { personId: p.id, source: "timeproof", days: [{ date: "2026-08-31", minutes: 424 }] });
    expect(again.body.unchanged).toBe(1);
    const fix = await call("POST", "/api/worklog/import", { personId: p.id, source: "timeproof", days: [{ date: "2026-08-31", minutes: 430 }] });
    expect(fix.body.updated).toBe(1);
    expect(ctx.repo.listWorklogs(p.id).filter((l) => l.date === "2026-08-31").length).toBe(1);
  });
  it("bookmarklet path: foreign origin needs the token", async () => {
    const p = ctx.repo.findPerson("Erica")!;
    const body = { personId: p.id, source: "timeproof", days: [{ date: "2026-09-04", minutes: 300 }] };
    const denied = await call("POST", "/api/worklog/import", body, { origin: "https://www.onlinejobs.ph" });
    expect(denied.status).toBe(401);
    const { token } = (await call("GET", "/api/worklog/token")).body;
    const ok = await call("POST", "/api/worklog/import", body, { origin: "https://www.onlinejobs.ph", "x-kairos-token": token });
    expect(ok.status).toBe(200);
    expect(ok.body.payroll.amount).toBeGreaterThan(0);
    const pre = await ctx.app.request("/api/worklog/import", { method: "OPTIONS", headers: { origin: "https://www.onlinejobs.ph", "access-control-request-method": "POST", "access-control-request-headers": "x-kairos-token" } });
    expect(pre.headers.get("access-control-allow-origin")).toBe("https://www.onlinejobs.ph");
    const rotated = (await call("POST", "/api/worklog/token/rotate")).body.token;
    expect(rotated).not.toBe(token);
    expect((await call("POST", "/api/worklog/import", body, { origin: "https://www.onlinejobs.ph", "x-kairos-token": token })).status).toBe(401);
  });
  it("brief and context mention the team; the light-week watcher fires on a Friday", async () => {
    const brief = (await call("GET", "/api/brief?kind=morning")).body;
    expect(brief.sections.some((s: { id: string }) => s.id === "team")).toBe(true);
    expect(ctx.svc.contextSnapshot(now)).toMatch(/Team \(paid workers\): Erica/);
    const p = ctx.repo.findPerson("Erica")!;
    ctx.repo.updatePerson(p.id, { expectedWeeklyHours: 80 });
    const fired = ctx.scheduler.tick();
    expect(fired.watchers).toContain("wat_team");
    expect((await call("GET", "/api/nudges")).body.some((n: { title: string }) => /Erica is at/.test(n.title))).toBe(true);
  });
  it("export carries worklogs and import restores them", async () => {
    const e = (await call("GET", "/api/export")).body;
    expect(e.worklogs.length).toBeGreaterThan(5);
    const fresh = createApp({ now: () => now, webDir: "/nonexistent", log: false });
    const r = await fresh.app.request("/api/import", { method: "POST", body: JSON.stringify(e), headers: { "content-type": "application/json" } });
    const j = await r.json() as { imported: Record<string, number> };
    expect(j.imported.people).toBe(1);
    expect(j.imported.worklogs).toBe(e.worklogs.length);
    fresh.close();
  });
});
