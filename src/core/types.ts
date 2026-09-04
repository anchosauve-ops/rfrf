/** Kairos domain model. Pure data; no behavior. */

export type ID = string;
/** ISO-8601 timestamp (always UTC on the wire). */
export type ISO = string;

// ---------- Recurrence ----------
export type Freq = "daily" | "weekly" | "monthly" | "yearly";
export interface RRule {
  freq: Freq;
  interval?: number; // default 1
  byWeekday?: number[]; // 0=Sun..6=Sat (weekly)
  byMonthDay?: number; // (monthly)
  time?: string; // "HH:MM" wall time in the user's zone
  until?: ISO;
}

// ---------- Tasks ----------
/** 1 = critical, 2 = important, 3 = normal, 4 = someday */
export type Priority = 1 | 2 | 3 | 4;
/** What kind of energy the task needs; the planner matches it to your day's curve. */
export type Energy = "deep" | "light" | "admin" | "social";
export type TaskStatus = "open" | "done" | "dropped";
export type Source = "user" | "agent" | "import" | "ritual";

export interface Task {
  id: ID;
  title: string;
  notes?: string;
  status: TaskStatus;
  priority: Priority;
  energy: Energy;
  estimateMin: number;
  due?: ISO;
  /** Hard-pinned time (user said "at 3pm"); the planner respects it. */
  pinnedStart?: ISO;
  /** When the planner last placed it. Soft; recomputed daily. */
  plannedStart?: ISO;
  plannedEnd?: ISO;
  snoozedUntil?: ISO;
  project?: string;
  goalId?: ID;
  tags: string[];
  peopleIds: ID[];
  recurrence?: RRule;
  source: Source;
  createdAt: ISO;
  updatedAt: ISO;
  completedAt?: ISO;
}

// ---------- Events ----------
export type EventKind = "meeting" | "focus" | "personal" | "travel" | "ritual";
export interface Event {
  id: ID;
  title: string;
  start: ISO;
  end: ISO;
  allDay: boolean;
  kind: EventKind;
  location?: string;
  notes?: string;
  peopleIds: ID[];
  source: Source;
  createdAt: ISO;
  updatedAt: ISO;
}

// ---------- Memory ----------
export type MemoryKind = "fact" | "preference" | "goal" | "relationship" | "insight" | "episode";
export type MemorySource = "stated" | "inferred" | "imported";
export interface Memory {
  id: ID;
  text: string;
  kind: MemoryKind;
  tags: string[];
  /** 0..1 how much this should shape behavior */
  importance: number;
  /** 0..1 how sure we are it's true */
  confidence: number;
  source: MemorySource;
  /** Where it came from, quoted, so the user can audit it. */
  evidence?: string;
  pinned: boolean;
  accessCount: number;
  lastAccessedAt?: ISO;
  createdAt: ISO;
  updatedAt: ISO;
  expiresAt?: ISO;
}

// ---------- People ----------
export interface Person {
  id: ID;
  name: string;
  relation?: string;
  notes?: string;
  tags: string[];
  lastContactAt?: ISO;
  /** Desired days between touches; the agent nudges when exceeded. */
  cadenceDays?: number;
  birthday?: string; // "MM-DD"
  /** Someone who works for you: pay rate and expectations drive payroll and the team watcher. */
  hourlyRate?: number;
  currency?: string; // ISO 4217, default USD
  expectedWeeklyHours?: number;
  createdAt: ISO;
  updatedAt: ISO;
}

// ---------- Work logs (hours a worker put in, per day) ----------
export type WorkLogSource = "timeproof" | "paste" | "manual" | "import";
export interface WorkLog {
  id: ID;
  personId: ID;
  /** YYYY-MM-DD in the viewer's zone (Timeproof shows the employer's zone) */
  date: string;
  minutes: number;
  source: WorkLogSource;
  note?: string;
  importedAt: ISO;
}
export interface PayrollWeek {
  start: string; // Sunday YYYY-MM-DD
  end: string; // Saturday YYYY-MM-DD
  minutes: number;
  amount: number;
}
export interface Payroll {
  personId: ID;
  name: string;
  from: string;
  to: string;
  rate: number;
  currency: string;
  days: { date: string; minutes: number }[];
  weeks: PayrollWeek[];
  totalMinutes: number;
  amount: number;
  expectedWeeklyHours?: number;
  generatedAt: ISO;
}

// ---------- Rituals & watchers ----------
export type RitualKind = "morning_brief" | "evening_review" | "weekly_retro" | "reflection" | "custom";
export interface Ritual {
  id: ID;
  name: string;
  kind: RitualKind;
  rule: RRule; // must include time
  enabled: boolean;
  prompt?: string; // for custom rituals
  lastRunAt?: ISO;
  createdAt: ISO;
}

export type WatcherKind =
  | "overdue_tasks"
  | "stale_people"
  | "overloaded_day"
  | "unplanned_day"
  | "deadline_approaching"
  | "deadline_risk"
  | "team_hours";

export interface Watcher {
  id: ID;
  kind: WatcherKind;
  name: string;
  enabled: boolean;
  /** kind-specific threshold, e.g. days overdue, hours load */
  threshold: number;
  cooldownMin: number;
  lastFiredAt?: ISO;
}

// ---------- Nudges (the agent's inbox to you) ----------
export type NudgeLevel = "info" | "suggest" | "act";
export interface NudgeAction {
  label: string;
  /** A command the agent understands, executed when clicked. */
  command: string;
  style?: "primary" | "ghost" | "danger";
}
export interface Nudge {
  id: ID;
  title: string;
  body: string;
  level: NudgeLevel;
  cards?: Card[];
  actions?: NudgeAction[];
  origin: string; // ritual/watcher id or "agent"
  createdAt: ISO;
  readAt?: ISO;
  dismissedAt?: ISO;
}

// ---------- Preferences ----------
export interface EnergySlot {
  /** minutes since midnight */
  fromMin: number;
  toMin: number;
  /** what you're best at during this window */
  best: Energy;
}
export interface Preferences {
  name: string;
  timezone: string;
  workdayStartMin: number; // e.g. 540 = 09:00
  workdayEndMin: number; // e.g. 1080 = 18:00
  workDays: number[]; // 0..6
  energyCurve: EnergySlot[];
  focusBlockMin: number; // default 90
  breakMin: number; // default 10
  meetingBufferMin: number; // default 5
  theme: "system" | "light" | "dark";
  voice: boolean;
  model: string;
  /** Agent autonomy: 'ask' confirms every write; 'act' writes freely, narrates after; 'guardian' also intervenes on predicted risk (logged, undoable). */
  autonomy: "ask" | "act" | "guardian";
  /** Let the learned calibration scale estimates in the planner. */
  useCalibration: boolean;
  /** Let Kairos adopt its learned energy curve automatically when evidence is strong. */
  autoTuneCurve: boolean;
  onboarded: boolean;
}

// ---------- Plan ----------
export type BlockKind = "task" | "event" | "break" | "buffer" | "free";
export interface PlanBlock {
  id: ID;
  kind: BlockKind;
  title: string;
  start: ISO;
  end: ISO;
  taskId?: ID;
  eventId?: ID;
  energy?: Energy;
  reason?: string;
  /** Part n of m when a task is split */
  part?: [number, number];
}
export interface Plan {
  date: string; // YYYY-MM-DD
  blocks: PlanBlock[];
  unscheduled: { taskId: ID; title: string; reason: string }[];
  stats: {
    focusMin: number;
    meetingMin: number;
    breakMin: number;
    freeMin: number;
    loadPct: number; // committed / available
    taskCount: number;
  };
  generatedAt: ISO;
}

// ---------- Brief ----------
export interface BriefSection {
  id: string;
  title: string;
  lines: string[];
  cards?: Card[];
}
export interface Brief {
  date: string;
  kind: "morning" | "evening" | "weekly";
  greeting: string;
  headline: string;
  sections: BriefSection[];
  narrative?: string; // LLM-written when available
  generatedAt: ISO;
}

// ---------- Generative UI cards ----------
export type Card =
  | { type: "text"; markdown: string }
  | { type: "tasks"; title?: string; tasks: Task[] }
  | { type: "events"; title?: string; events: Event[] }
  | { type: "plan"; plan: Plan }
  | { type: "brief"; brief: Brief }
  | { type: "memories"; title?: string; memories: Memory[] }
  | { type: "people"; title?: string; people: Person[] }
  | { type: "checklist"; title: string; items: { text: string; done: boolean }[] }
  | { type: "decision"; question: string; options: { label: string; rationale: string; command?: string }[] }
  | { type: "metrics"; title?: string; items: { label: string; value: string; hint?: string }[] }
  | { type: "confirm"; summary: string; command: string }
  | { type: "focus"; taskId?: ID; title: string; minutes: number }
  | { type: "risk"; report: RiskReport }
  | { type: "council"; verdict: CouncilVerdict }
  | { type: "calibration"; calibration: Calibration }
  | { type: "goals"; goals: Goal[]; alignment?: { goalId: ID; title: string; focusMin: number; share: number }[] }
  | { type: "ledger"; entries: LedgerEntry[] }
  | { type: "payroll"; payroll: Payroll };

// ---------- Goals ----------
export type GoalHorizon = "week" | "month" | "quarter" | "year";
export interface Goal {
  id: ID;
  title: string;
  why?: string;
  horizon: GoalHorizon;
  targetDate?: ISO;
  /** 0..1, manual or derived from linked tasks */
  progress: number;
  status: "active" | "done" | "paused";
  pinned: boolean;
  createdAt: ISO;
  updatedAt: ISO;
}

// ---------- Learning (symbiosis) ----------
/** One completed unit of work: what we predicted vs what happened. */
export interface Outcome {
  id: ID;
  taskId: ID;
  title: string;
  energy: Energy;
  tags: string[];
  goalId?: ID;
  estimateMin: number;
  /** minutes actually spent, when known (focus sessions or explicit report) */
  actualMin?: number;
  plannedStart?: ISO;
  completedAt: ISO;
  /** hour of day (0-23) in the person's zone when it was completed */
  hour: number;
  weekday: number;
  /** completed after its due date */
  slipped: boolean;
  /** completed on the day it was planned for */
  onPlan?: boolean;
}

export interface Calibration {
  /** multiply estimates by this, per energy (1 = accurate, 1.6 = you underestimate by 60%) */
  estimateBias: Record<Energy, { factor: number; n: number; confidence: number }>;
  /** 24 buckets: relative completion propensity by hour, 0..1 normalized */
  hourPropensity: number[];
  /** per energy: the hours where that kind of work actually gets done, ranked */
  peakHours: Record<Energy, number[]>;
  /** share of planned tasks completed on the planned day */
  planAdherence: { rate: number; n: number };
  /** slip rate by tag and energy */
  slipRate: { byEnergy: Record<Energy, number>; byTag: Record<string, number>; overall: number; n: number };
  /** learned energy curve proposal, if evidence is strong enough */
  proposedCurve?: EnergySlot[];
  sampleSize: number;
  generatedAt: ISO;
}

// ---------- Futures (simulation) ----------
export interface TaskRisk {
  taskId: ID;
  title: string;
  due: ISO;
  priority: Priority;
  /** probability of missing the deadline, 0..1 */
  pMiss: number;
  /** median expected completion day key */
  expectedDay: string;
  /** median expected completion instant */
  expectedAt: ISO;
  level: "safe" | "watch" | "danger";
  goalId?: ID;
}
export interface Intervention {
  id: string;
  kind: "defer" | "shrink" | "drop" | "protect" | "move_meeting" | "reorder";
  title: string;
  detail: string;
  /** share of total baseline deadline risk removed if applied, 0..1 */
  riskDelta: number;
  command: string;
  targetTaskId?: ID;
  targetEventId?: ID;
}
export interface RiskReport {
  horizonDays: number;
  runs: number;
  risks: TaskRisk[];
  interventions: Intervention[];
  /** expected focus minutes available vs demanded over horizon */
  capacity: { availableMin: number; demandedMin: number; ratio: number };
  /** per day over horizon: expected load 0..1+ */
  loadByDay: { day: string; load: number; meetingsMin: number }[];
  generatedAt: ISO;
  seed: number;
}

// ---------- Council (deliberation) ----------
export type Perspective = "strategist" | "realist" | "guardian" | "connector" | "editor";
export interface CouncilFinding {
  perspective: Perspective;
  severity: "note" | "warn" | "critical";
  claim: string;
  evidence: string;
  suggestion?: string;
  command?: string;
}
export interface CouncilVerdict {
  question: string;
  findings: CouncilFinding[];
  synthesis: string;
  /** the single most important thing to do next */
  decision: string;
  mode: "claude" | "local";
  generatedAt: ISO;
}

// ---------- Ledger (autonomous actions, all reversible) ----------
export interface LedgerEntry {
  id: ID;
  action: string; // e.g. "defer_task", "replan", "shrink_estimate"
  summary: string;
  reason: string;
  /** what to do to reverse it */
  undo: { entity: "task" | "event" | "prefs"; id?: ID; patch: Record<string, unknown> }[];
  origin: string; // watcher/ritual id or "agent"
  createdAt: ISO;
  undoneAt?: ISO;
}

// ---------- Conversation ----------
export type Role = "user" | "assistant" | "system";
export interface Turn {
  id: ID;
  conversationId: ID;
  role: Role;
  text: string;
  cards?: Card[];
  createdAt: ISO;
}

// ---------- Agent streaming protocol ----------
export type AgentEvent =
  | { type: "start"; turnId: ID; mode: "claude" | "local" }
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_start"; name: string; input: unknown }
  | { type: "tool_end"; name: string; ok: boolean; summary: string }
  | { type: "card"; card: Card }
  | { type: "mutation"; entity: "task" | "event" | "memory" | "person" | "nudge" | "plan" | "prefs" | "goal" | "ledger" | "worklog" }
  | { type: "done"; turnId: ID; text: string; cards: Card[] }
  | { type: "error"; message: string };

export const DEFAULT_PREFERENCES: Preferences = {
  name: "",
  timezone: "UTC",
  workdayStartMin: 9 * 60,
  workdayEndMin: 18 * 60,
  workDays: [1, 2, 3, 4, 5],
  energyCurve: [
    { fromMin: 8 * 60, toMin: 12 * 60, best: "deep" },
    { fromMin: 12 * 60, toMin: 14 * 60, best: "social" },
    { fromMin: 14 * 60, toMin: 16 * 60, best: "light" },
    { fromMin: 16 * 60, toMin: 19 * 60, best: "admin" },
  ],
  focusBlockMin: 90,
  breakMin: 10,
  meetingBufferMin: 5,
  theme: "system",
  voice: false,
  model: "claude-opus-5",
  autonomy: "act",
  useCalibration: true,
  autoTuneCurve: false,
  onboarded: false,
};
