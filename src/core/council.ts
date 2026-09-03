/**
 * Council — deliberation before advice.
 *
 * Five perspectives look at the same week and argue. Offline, each is a
 * deterministic critic over the data. With a model, each perspective is a
 * separate call with its own charter, then one synthesis. The person sees
 * the disagreement, not just the verdict; that's how trust is earned.
 */
import type { Calibration, CouncilFinding, CouncilVerdict, Event, Goal, Memory, Perspective, Person, Plan, Preferences, RiskReport, Task } from "./types.js";
import { staleness } from "./brief.js";
import { alignment } from "./goals.js";
import { minutesBetween } from "./tz.js";

export interface CouncilInput {
  question?: string;
  now: Date;
  tz: string;
  prefs: Preferences;
  tasks: Task[]; // all
  events: Event[]; // this week
  people: Person[];
  memories: Memory[];
  goals: Goal[];
  plan?: Plan;
  risk?: RiskReport;
  calibration?: Calibration;
}

export const CHARTERS: Record<Perspective, string> = {
  strategist: "Are we spending time on what matters most? Goals, leverage, the one thing that would make the rest easier.",
  realist: "Will this actually happen? Estimates, capacity, history of slipping, honesty about the calendar.",
  guardian: "Is this sustainable? Energy, breaks, sleep, overload, saying no.",
  connector: "Who is being neglected? Relationships, follow-ups, promises made to people.",
  editor: "What should be cut? Duplicates, someday-maybes masquerading as tasks, meetings that could be messages.",
};

export function localCouncil(input: CouncilInput): CouncilVerdict {
  const f: CouncilFinding[] = [];
  const open = input.tasks.filter((t) => t.status === "open");
  const now = input.now;

  // ---- strategist ----
  const active = input.goals.filter((g) => g.status === "active");
  if (!active.length) f.push({ perspective: "strategist", severity: "warn", claim: "There's no stated goal, so the plan optimizes urgency instead of direction.", evidence: `${open.length} open tasks, 0 active goals.`, suggestion: "Name one goal for this month.", command: "goal: " });
  else {
    const al = alignment(input.goals, input.tasks, { plan: input.plan });
    const top = al[0];
    if (top && top.share < 0.25 && input.plan) f.push({ perspective: "strategist", severity: "warn", claim: `Only ${Math.round(top.share * 100)}% of today's focus serves “${top.title}”.`, evidence: `${top.focusMin} min planned toward it out of the day's task blocks.`, suggestion: "Put one goal task in the morning slot.", command: "plan my day" });
    const orphanGoals = active.filter((g) => !open.some((t) => t.goalId === g.id));
    if (orphanGoals[0]) f.push({ perspective: "strategist", severity: "note", claim: `“${orphanGoals[0].title}” has no open task attached.`, evidence: "A goal with no next action is a wish.", suggestion: `Add the next concrete step.`, command: `remind me to ` });
  }

  // ---- realist ----
  if (input.risk) {
    const danger = input.risk.risks.filter((r) => r.level === "danger");
    if (danger[0]) f.push({ perspective: "realist", severity: "critical", claim: `“${danger[0].title}” misses its deadline in ${Math.round(danger[0].pMiss * 100)}% of simulated weeks.`, evidence: `${input.risk.runs} runs; expected finish ${danger[0].expectedDay}.`, suggestion: input.risk.interventions[0]?.title, command: input.risk.interventions[0]?.command });
    if (input.risk.capacity.ratio > 1.1) f.push({ perspective: "realist", severity: "warn", claim: `You've committed ${Math.round(input.risk.capacity.ratio * 100)}% of the focus time that exists this week.`, evidence: `${Math.round(input.risk.capacity.demandedMin / 60)}h demanded vs ${Math.round(input.risk.capacity.availableMin / 60)}h available after meetings and slack.`, suggestion: "Something moves to next week now, while it's a choice.", command: "what's overdue" });
  }
  if (input.calibration) {
    const b = input.calibration.estimateBias.deep;
    if (b.n >= 3 && b.factor >= 1.3) f.push({ perspective: "realist", severity: "note", claim: `Your deep-work estimates run ${Math.round((b.factor - 1) * 100)}% short.`, evidence: `${b.n} completed deep tasks.`, suggestion: input.prefs.useCalibration ? "The planner is already correcting for it." : "Turn on calibration so the planner corrects for it." });
  }

  // ---- guardian ----
  if (input.plan) {
    const focus = input.plan.stats.focusMin;
    const breaks = input.plan.stats.breakMin;
    if (input.plan.stats.loadPct >= 90) f.push({ perspective: "guardian", severity: "warn", claim: `Today is planned at ${input.plan.stats.loadPct}%.`, evidence: `${Math.round(focus / 6) / 10}h focus + ${Math.round(input.plan.stats.meetingMin / 6) / 10}h meetings.`, suggestion: "Days this full don't survive one surprise. Pick the task you'd drop.", command: "what's on my list today" });
    if (focus >= 300 && breaks < 20) f.push({ perspective: "guardian", severity: "note", claim: "Five-plus hours of focus with under twenty minutes of breaks.", evidence: `${breaks} min of breaks planned.`, suggestion: "Shorten the focus block setting to 60 min." });
  }
  const lateMeetings = input.events.filter((e) => !e.allDay && minutesBetween(new Date(e.start), new Date(e.end)) > 0 && new Date(e.start).getUTCHours() >= 0 && new Date(e.start) > now).length;
  void lateMeetings;
  const coffee = input.memories.find((m) => /coffee|sleep/i.test(m.text) && m.kind === "insight");
  if (coffee) f.push({ perspective: "guardian", severity: "note", claim: coffee.text, evidence: coffee.evidence ?? "From memory.", suggestion: "Worth honoring on a heavy day." });

  // ---- connector ----
  const stale = input.people.map((p) => ({ p, s: staleness(p, now) })).filter((x) => x.s.ratio >= 1).sort((a, b) => b.s.ratio - a.s.ratio);
  if (stale[0]) f.push({ perspective: "connector", severity: stale[0].s.ratio >= 1.5 ? "warn" : "note", claim: `${stale[0].p.name} is ${Math.round(stale[0].s.ratio * 100)}% past cadence${stale.length > 1 ? `, and ${stale.length - 1} other${stale.length > 2 ? "s are" : " is"} drifting` : ""}.`, evidence: stale[0].p.lastContactAt ? `Last contact ${stale[0].p.lastContactAt.slice(0, 10)}.` : "No contact logged.", suggestion: `Fifteen minutes with ${stale[0].p.name} this week.`, command: `reach out to ${stale[0].p.name} tomorrow` });
  const socialOpen = open.filter((t) => t.energy === "social" && t.due && new Date(t.due) < now);
  if (socialOpen[0]) f.push({ perspective: "connector", severity: "note", claim: `“${socialOpen[0].title}” is overdue and it involves a person.`, evidence: "Overdue social tasks cost more than overdue admin.", command: `done with ${socialOpen[0].title}` });

  // ---- editor ----
  const someday = open.filter((t) => t.priority === 4);
  if (someday.length >= 3) f.push({ perspective: "editor", severity: "note", claim: `${someday.length} someday tasks are sitting in the open list.`, evidence: someday.slice(0, 3).map((t) => t.title).join(", "), suggestion: "Drop the ones you wouldn't miss.", command: "show someday tasks" });
  const old = open.filter((t) => (now.getTime() - new Date(t.createdAt).getTime()) / 86400000 > 30 && !t.due);
  if (old[0]) f.push({ perspective: "editor", severity: "note", claim: `“${old[0].title}” has been open ${Math.round((now.getTime() - new Date(old[0].createdAt).getTime()) / 86400000)} days with no date.`, evidence: "Undated tasks older than a month rarely get done.", suggestion: "Date it or drop it.", command: `drop ${old[0].title}` });
  const meetings = input.events.filter((e) => e.kind === "meeting" && new Date(e.start) > now);
  const meetMin = meetings.reduce((n, e) => n + minutesBetween(new Date(e.start), new Date(e.end)), 0);
  if (meetMin >= 8 * 60) f.push({ perspective: "editor", severity: "warn", claim: `${Math.round(meetMin / 60)} hours of meetings ahead this week.`, evidence: `${meetings.length} meetings.`, suggestion: "One of them is an email." });

  const order: Record<CouncilFinding["severity"], number> = { critical: 0, warn: 1, note: 2 };
  f.sort((a, b) => order[a.severity] - order[b.severity]);
  const top = f[0];
  const synthesis = f.length
    ? `${f.filter((x) => x.severity === "critical").length} critical, ${f.filter((x) => x.severity === "warn").length} warnings, ${f.filter((x) => x.severity === "note").length} notes. ${top ? `The ${top.perspective} has the floor: ${top.claim}` : ""}`
    : "The council has nothing to add. The week looks honest.";
  const decision = top?.suggestion ?? top?.claim ?? "Keep going.";
  return { question: input.question ?? "How does this week look?", findings: f, synthesis, decision, mode: "local", generatedAt: now.toISOString() };
}
