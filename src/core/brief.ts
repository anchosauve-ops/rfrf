/**
 * Brief — the ritual voice of Kairos. Composes the morning brief, evening
 * review and weekly retro deterministically from data; a model can add a
 * narrative on top but the structure never depends on one.
 */
import type { Brief, BriefSection, Event, Memory, Person, Plan, Preferences, Task, WorkLog } from "./types.js";
import { computePayroll, fmtHM, formatMoney, weekStart, addDaysKey } from "./worklog.js";
import { dayKey, formatTime, minutesBetween, sameDay, toZoned } from "./tz.js";
import { recencyFactor } from "./memory.js";

export interface BriefInput {
  kind: "morning" | "evening" | "weekly";
  now: Date;
  tz: string;
  prefs: Preferences;
  tasks: Task[]; // all tasks (open + done)
  events: Event[];
  people: Person[];
  memories: Memory[];
  plan?: Plan;
  /** work logs for people with a rate, so the brief can report team hours */
  worklogs?: WorkLog[];
}

/** One line per paid worker: hours and cost this week, flagged when light. */
export function teamSection(people: Person[], worklogs: WorkLog[], now: Date, tz: string): BriefSection | undefined {
  const paid = people.filter((p) => p.hourlyRate);
  if (!paid.length) return undefined;
  const today = dayKey(now, tz);
  const from = weekStart(today);
  const to = addDaysKey(from, 6);
  const lines = paid.map((p) => {
    const pr = computePayroll({ personId: p.id, name: p.name, logs: worklogs.filter((l) => l.personId === p.id), rate: p.hourlyRate!, currency: p.currency, from, to, now });
    const light = p.expectedWeeklyHours && toZoned(now, tz).weekday >= 4 && pr.totalMinutes < p.expectedWeeklyHours * 60 * 0.6;
    return `${p.name}: ${fmtHM(pr.totalMinutes)} this week · ${formatMoney(pr.amount, pr.currency)}${light ? ` · light (expects ${p.expectedWeeklyHours}h)` : ""}`;
  });
  return { id: "team", title: "Team", lines };
}

function greetingFor(now: Date, tz: string, name: string): string {
  const h = toZoned(now, tz).hour;
  const g = h < 5 ? "Still up" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  return name ? `${g}, ${name}.` : `${g}.`;
}

export function staleness(p: Person, now: Date): { overdueDays: number; ratio: number } {
  if (!p.cadenceDays) return { overdueDays: 0, ratio: 0 };
  const last = p.lastContactAt ? new Date(p.lastContactAt) : new Date(p.createdAt);
  const days = (now.getTime() - last.getTime()) / 86400000;
  return { overdueDays: Math.max(0, Math.floor(days - p.cadenceDays)), ratio: days / p.cadenceDays };
}

export function composeBrief(input: BriefInput): Brief {
  const { kind, now, tz, prefs } = input;
  const today = dayKey(now, tz);
  const open = input.tasks.filter((t) => t.status === "open");
  const overdue = open.filter((t) => t.due && new Date(t.due) < now && !sameDay(new Date(t.due), now, tz)).sort((a, b) => a.due!.localeCompare(b.due!));
  const dueToday = open.filter((t) => t.due && sameDay(new Date(t.due), now, tz));
  const todaysEvents = input.events.filter((e) => sameDay(new Date(e.start), now, tz)).sort((a, b) => a.start.localeCompare(b.start));
  const stalePeople = input.people
    .map((p) => ({ p, s: staleness(p, now) }))
    .filter((x) => x.s.ratio >= 1)
    .sort((a, b) => b.s.ratio - a.s.ratio)
    .slice(0, 3);
  const goals = input.memories.filter((m) => m.kind === "goal").sort((a, b) => b.importance * recencyFactor(b, now) - a.importance * recencyFactor(a, now));
  const sections: BriefSection[] = [];
  const greeting = greetingFor(now, tz, prefs.name);

  if (kind === "morning") {
    const meetingMin = todaysEvents.reduce((n, e) => n + (e.allDay ? 0 : minutesBetween(new Date(e.start), new Date(e.end))), 0);
    const first = todaysEvents.find((e) => !e.allDay && new Date(e.start) > now);
    const headline =
      todaysEvents.length === 0 && dueToday.length === 0 && overdue.length === 0
        ? "A clear day. Protect it."
        : `${todaysEvents.length} event${todaysEvents.length === 1 ? "" : "s"}${meetingMin ? ` (${Math.round(meetingMin / 60 * 10) / 10}h)` : ""}, ${dueToday.length} due today${overdue.length ? `, ${overdue.length} overdue` : ""}.`;

    if (todaysEvents.length)
      sections.push({
        id: "schedule",
        title: "Schedule",
        lines: todaysEvents.map((e) => `${e.allDay ? "All day" : formatTime(new Date(e.start), tz)} — ${e.title}`),
        cards: [{ type: "events", events: todaysEvents }],
      });
    if (first) sections[sections.length - 1]!.lines.unshift(`First up: ${first.title} at ${formatTime(new Date(first.start), tz)}${minutesBetween(now, new Date(first.start)) < 120 ? ` (in ${minutesBetween(now, new Date(first.start))} min)` : ""}`);

    const top = input.plan
      ? input.plan.blocks.filter((b) => b.kind === "task").map((b) => open.find((t) => t.id === b.taskId)).filter((t): t is Task => !!t)
      : [...dueToday, ...open.filter((t) => !dueToday.includes(t))].sort((a, b) => a.priority - b.priority);
    const seen = new Set<string>();
    const top3 = top.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true))).slice(0, 3);
    if (top3.length)
      sections.push({
        id: "top3",
        title: "If you only do three things",
        lines: top3.map((t, i) => `${i + 1}. ${t.title}${t.due && sameDay(new Date(t.due), now, tz) ? " (due today)" : ""}`),
        cards: [{ type: "tasks", tasks: top3 }],
      });
    if (overdue.length)
      sections.push({
        id: "overdue",
        title: "Slipped",
        lines: overdue.slice(0, 5).map((t) => `${t.title} — was due ${new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" }).format(new Date(t.due!))}`),
        cards: [{ type: "tasks", tasks: overdue.slice(0, 5) }],
      });
    if (stalePeople.length)
      sections.push({
        id: "people",
        title: "People drifting",
        lines: stalePeople.map(({ p, s }) => `${p.name}${p.relation ? ` (${p.relation})` : ""} — ${s.overdueDays ? `${s.overdueDays}d past cadence` : "due for a touch"}`),
        cards: [{ type: "people", people: stalePeople.map((x) => x.p) }],
      });
    if (input.plan)
      sections.push({
        id: "plan",
        title: "The shape of the day",
        lines: [
          `${Math.round(input.plan.stats.focusMin / 6) / 10}h focus · ${Math.round(input.plan.stats.meetingMin / 6) / 10}h meetings · ${input.plan.stats.loadPct}% load`,
          ...(input.plan.unscheduled.length ? [`${input.plan.unscheduled.length} task${input.plan.unscheduled.length > 1 ? "s" : ""} didn't fit — that's fine.`] : []),
        ],
        cards: [{ type: "plan", plan: input.plan }],
      });
    const team = teamSection(input.people, input.worklogs ?? [], now, tz);
    if (team) sections.push(team);
    if (goals[0]) sections.push({ id: "north", title: "North star", lines: [goals[0].text] });

    return { date: today, kind, greeting, headline, sections, generatedAt: now.toISOString() };
  }

  if (kind === "evening") {
    const doneToday = input.tasks.filter((t) => t.status === "done" && t.completedAt && sameDay(new Date(t.completedAt), now, tz));
    const plannedToday = input.plan?.blocks.filter((b) => b.kind === "task") ?? [];
    const plannedIds = new Set(plannedToday.map((b) => b.taskId));
    const missed = open.filter((t) => plannedIds.has(t.id));
    const headline = doneToday.length ? `${doneToday.length} done${missed.length ? `, ${missed.length} carried over` : ""}. ${doneToday.length >= 3 ? "Solid." : "That counts."}` : "Nothing checked off today — days like that happen.";
    if (doneToday.length) sections.push({ id: "done", title: "Shipped", lines: doneToday.map((t) => `✓ ${t.title}`), cards: [{ type: "tasks", tasks: doneToday }] });
    if (missed.length) sections.push({ id: "carry", title: "Carrying to tomorrow", lines: missed.map((t) => t.title), cards: [{ type: "tasks", tasks: missed }] });
    const tomorrowEvents = input.events.filter((e) => dayKey(new Date(e.start), tz) === dayKey(new Date(now.getTime() + 86400000), tz)).sort((a, b) => a.start.localeCompare(b.start));
    if (tomorrowEvents.length) sections.push({ id: "tomorrow", title: "Tomorrow, first look", lines: tomorrowEvents.slice(0, 4).map((e) => `${e.allDay ? "All day" : formatTime(new Date(e.start), tz)} — ${e.title}`), cards: [{ type: "events", events: tomorrowEvents }] });
    sections.push({ id: "reflect", title: "One question", lines: [pickReflection(now)] });
    return { date: today, kind, greeting: greetingFor(now, tz, prefs.name), headline, sections, generatedAt: now.toISOString() };
  }

  // weekly
  const weekAgo = new Date(now.getTime() - 7 * 86400000);
  const doneWeek = input.tasks.filter((t) => t.status === "done" && t.completedAt && new Date(t.completedAt) >= weekAgo);
  const createdWeek = input.tasks.filter((t) => new Date(t.createdAt) >= weekAgo);
  const meetings = input.events.filter((e) => new Date(e.start) >= weekAgo && new Date(e.start) <= now && !e.allDay);
  const meetingH = Math.round(meetings.reduce((n, e) => n + minutesBetween(new Date(e.start), new Date(e.end)), 0) / 6) / 10;
  const byEnergy = doneWeek.reduce<Record<string, number>>((acc, t) => ((acc[t.energy] = (acc[t.energy] ?? 0) + 1), acc), {});
  const headline = `${doneWeek.length} done, ${createdWeek.length} added, ${meetingH}h in meetings.`;
  sections.push({
    id: "numbers",
    title: "The numbers",
    lines: [`Completed: ${doneWeek.length}`, `Added: ${createdWeek.length}`, `Net: ${doneWeek.length - createdWeek.length >= 0 ? "+" : ""}${doneWeek.length - createdWeek.length}`, `Meetings: ${meetingH}h`, `Overdue now: ${overdue.length}`],
    cards: [
      {
        type: "metrics",
        items: [
          { label: "Done", value: String(doneWeek.length) },
          { label: "Added", value: String(createdWeek.length) },
          { label: "Meetings", value: `${meetingH}h` },
          { label: "Overdue", value: String(overdue.length) },
          ...Object.entries(byEnergy).map(([k, v]) => ({ label: `${k} tasks`, value: String(v) })),
        ],
      },
    ],
  });
  if (doneWeek.length) sections.push({ id: "wins", title: "Wins", lines: doneWeek.slice(0, 8).map((t) => `✓ ${t.title}`) });
  if (overdue.length) sections.push({ id: "debt", title: "Debt", lines: overdue.slice(0, 6).map((t) => t.title), cards: [{ type: "tasks", tasks: overdue.slice(0, 6) }] });
  if (goals.length) sections.push({ id: "goals", title: "Against your goals", lines: goals.slice(0, 3).map((g) => g.text) });
  if (stalePeople.length) sections.push({ id: "people", title: "People", lines: stalePeople.map(({ p }) => `Reach out to ${p.name}`) });
  const team = teamSection(input.people, input.worklogs ?? [], now, tz);
  if (team) sections.push({ ...team, title: "Team this week" });
  return { date: today, kind, greeting: greetingFor(now, tz, prefs.name), headline, sections, generatedAt: now.toISOString() };
}

const REFLECTIONS = [
  "What was the one thing today that actually moved something?",
  "What did you say yes to that you'd rather have said no to?",
  "Where did the time go that you didn't plan for?",
  "What would make tomorrow feel easier at 9am?",
  "Who did you help today? Who helped you?",
  "What are you avoiding, and what's the smallest first step?",
  "What deserved more attention than it got?",
];
export function pickReflection(now: Date): string {
  const day = Math.floor(now.getTime() / 86400000);
  return REFLECTIONS[day % REFLECTIONS.length]!;
}

/** Plain-text rendering of a brief (for voice, notifications, and the model). */
export function briefToText(b: Brief): string {
  const out = [b.greeting, b.headline, ""];
  for (const s of b.sections) {
    out.push(s.title.toUpperCase());
    out.push(...s.lines.map((l) => `  ${l}`));
    out.push("");
  }
  return out.join("\n").trim();
}
