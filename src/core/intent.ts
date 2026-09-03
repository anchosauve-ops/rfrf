/**
 * Intent — Kairos' offline command understanding.
 *
 * When there's no model in the loop (or the model is unreachable), this is
 * the brain. It maps everyday phrasing to structured intents with a
 * confidence score. When a model *is* in the loop, the same parser pre-fills
 * tool arguments so the model spends its effort on judgment, not parsing.
 */
import { parseChrono } from "./chrono.js";
import type { Energy, MemoryKind, Priority, RRule } from "./types.js";
import { nextOccurrence } from "./rrule.js";

export type Intent =
  | {
      type: "create_task";
      title: string;
      due?: string;
      pinnedStart?: string;
      estimateMin?: number;
      priority?: Priority;
      energy?: Energy;
      recurrence?: RRule;
      tags: string[];
      people: string[];
      project?: string;
    }
  | {
      type: "create_event";
      title: string;
      start: string;
      end: string;
      people: string[];
      location?: string;
      recurrence?: RRule;
    }
  | { type: "complete_task"; query: string }
  | { type: "drop_task"; query: string }
  | { type: "reschedule_task"; query: string; when: string; allDay: boolean }
  | { type: "list_tasks"; filter: "today" | "overdue" | "upcoming" | "all" | "someday" | "done" }
  | { type: "plan_day"; date: string }
  | { type: "brief"; kind: "morning" | "evening" | "weekly" }
  | { type: "remember"; text: string; kind: MemoryKind; tags: string[] }
  | { type: "recall"; query: string }
  | { type: "forget"; query: string }
  | { type: "create_person"; name: string; relation?: string; notes?: string; cadenceDays?: number }
  | { type: "log_contact"; name: string }
  | { type: "people_touch" }
  | { type: "start_focus"; minutes: number; query?: string }
  | { type: "schedule_view"; date: string }
  | { type: "set_preference"; key: string; value: string }
  | { type: "council"; question?: string }
  | { type: "futures" }
  | { type: "mirror" }
  | { type: "undo" }
  | { type: "create_goal"; title: string; horizon: "week" | "month" | "quarter" | "year"; targetDate?: string }
  | { type: "list_goals" }
  | { type: "help" }
  | { type: "chat"; text: string };

export interface ParsedIntent {
  intent: Intent;
  confidence: number; // 0..1
  /** Human-readable explanation of how it was parsed (for the audit trail). */
  trace: string[];
}

export interface IntentContext {
  now: Date;
  tz: string;
  workdayEndMin?: number;
}

const PRIORITY_WORDS: [RegExp, Priority][] = [
  [/(?<![\w!])(?:urgent|asap|critical|p1|!!!|!1)(?![\w!])/i, 1],
  [/(?<![\w!])(?:important|high(?:\s+priority)?|p2|!!|!2)(?![\w!])/i, 2],
  [/(?<![\w!])(?:low(?:\s+priority)?|someday|maybe|p4|!4)(?![\w!])/i, 4],
  [/(?<![\w!])(?:p3|!3|!)(?![\w!])/i, 3],
];
const ENERGY_WORDS: [RegExp, Energy][] = [
  [/\b(deep\s*work|deep|focus(?:ed)?|write|writing|design|code|coding|research|think(?:ing)?|draft|study)\b/i, "deep"],
  [/\b(call|meet|meeting|chat|catch\s*up|coffee|lunch|dinner|talk|sync|1:1|interview|reach\s+out)\b/i, "social"],
  [/\b(email|emails|inbox|invoice|invoices|expense|expenses|taxes|form|forms|paperwork|renew|pay|book|order|schedule|file|submit|admin|errand|errands|groceries|laundry|clean)\b/i, "admin"],
  [/\b(read|review|skim|watch|listen|tidy|organize|plan|sort)\b/i, "light"],
];

function stripEdges(s: string): string {
  return s
    .replace(/^[\s,.:;!?'"-]+|[\s,.:;!?'"-]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function extractTags(text: string): { text: string; tags: string[] } {
  const tags: string[] = [];
  const out = text.replace(/(^|\s)#([a-z0-9_-]+)/gi, (_m, sp: string, t: string) => {
    tags.push(t.toLowerCase());
    return sp;
  });
  return { text: out, tags };
}

function extractProject(text: string): { text: string; project?: string } {
  let project: string | undefined;
  const out = text.replace(/(^|\s)\+([a-z0-9_-]+)/gi, (_m, sp: string, p: string) => {
    project = p;
    return sp;
  });
  return { text: out, project };
}

function extractPriority(text: string): { text: string; priority?: Priority } {
  for (const [re, p] of PRIORITY_WORDS) {
    if (re.test(text)) return { text: text.replace(re, " "), priority: p };
  }
  return { text };
}

function extractEnergy(text: string): { text: string; energy?: Energy } {
  const explicit = /(^|\s)@(deep|light|admin|social)\b/i.exec(text);
  if (explicit) return { text: text.replace(explicit[0], " "), energy: explicit[2]!.toLowerCase() as Energy };
  for (const [re, e] of ENERGY_WORDS) if (re.test(text)) return { text, energy: e };
  return { text };
}

/** "with Sam and Priya" → ["Sam", "Priya"]; keeps original casing. */
function extractPeople(original: string): { text: string; people: string[] } {
  const m = /\bwith\s+((?:[A-Z][\w'-]+)(?:\s+(?:and|&|,)\s*[A-Z][\w'-]+)*)/.exec(original);
  if (!m) return { text: original, people: [] };
  const people = m[1]!.split(/\s*(?:and|&|,)\s*/).map(stripEdges).filter(Boolean);
  return { text: original, people }; // keep "with X" in title; it reads better
}

function extractLocation(text: string): { text: string; location?: string } {
  const m = /\b(?:at|in)\s+(the\s+)?([A-Z][\w'&-]+(?:\s+[A-Z][\w'&-]+){0,3})\s*$/.exec(text);
  if (!m) return { text };
  return { text: text.slice(0, m.index).trim(), location: `${m[1] ?? ""}${m[2]}`.trim() };
}

const TASK_LEADS = [
  /^(?:please\s+)?remind\s+me\s+(?:to\s+|about\s+|that\s+i\s+need\s+to\s+|that\s+)?/i,
  /^(?:please\s+)?(?:add|create|new|make)\s+(?:a\s+)?(?:new\s+)?(?:task|todo|to-do|reminder)(?:\s*[:-]\s*|\s+to\s+|\s+)/i,
  /^(?:task|todo|to-do|reminder)\s*[:-]?\s+/i,
  /^i\s+(?:need|have|want|got|ought)\s+to\s+/i,
  /^i\s+(?:should|must|gotta|have\s+got\s+to)\s+/i,
  /^(?:don'?t\s+forget|dont\s+forget|remember)\s+to\s+/i,
  /^note\s+to\s+self\s*[:-]?\s*(?:to\s+)?/i,
  /^(?:can\s+you\s+)?(?:put|add)\s+(.+?)\s+(?:on|to)\s+(?:my\s+)?(?:list|todo|to-do|tasks?)\b/i,
];

const EVENT_LEADS = [
  /^(?:please\s+)?(?:schedule|book|set\s+up|setup|put|block|add|create|plan)\s+(?:a\s+|an\s+|some\s+)?(?:new\s+)?(?:(meeting|call|session|block|event|time|slot|appointment|focus|lunch|dinner|coffee|1:1|one[- ]on[- ]one|interview|standup|sync|workout|gym|run)\b)?/i,
  /^(?:i\s+have\s+(?:a\s+|an\s+)?|i'?m\s+)(meeting|call|appointment|dentist|doctor|lunch|dinner|coffee|interview|flight|class|standup|sync)\b/i,
  /^(meeting|appointment|lunch|dinner|coffee|interview|standup|sync|workout|gym|flight|dentist|doctor|class)\b/i,
];

function looksLikeEvent(text: string): boolean {
  return /\b(meeting|appointment|dentist|doctor|lunch|dinner|coffee|interview|flight|class|standup|sync|workout|gym|1:1|one[- ]on[- ]one|session|block)\b/i.test(text);
}

export function parseIntent(raw: string, ctx: IntentContext): ParsedIntent {
  const trace: string[] = [];
  const original = raw.trim();
  let text = original.replace(/\s+/g, " ");
  const lower = text.toLowerCase().replace(/[.!?]+$/, "").trim();

  // ---------- Meta / navigation ----------
  if (/^(help|\?|what can you do|commands?)$/i.test(lower)) return { intent: { type: "help" }, confidence: 1, trace: ["help"] };

  if (/^(?:(?:good\s+)?morning|(?:morning|daily)\s+brief(?:ing)?|brief(?:ing)?(?:\s+me)?|what'?s\s+(?:on|up)\s+today|how'?s\s+(?:my\s+)?(?:day|today)\s+look(?:ing)?|what\s+does\s+(?:my\s+)?(?:day|today)\s+look\s+like|today\??)$/i.test(lower))
    return { intent: { type: "brief", kind: "morning" }, confidence: 0.95, trace: ["brief:morning"] };
  if (/^(?:(?:good\s+)?evening|evening\s+(?:review|brief)|(?:daily\s+)?review|wrap\s+up|shutdown|end\s+(?:of\s+)?day\s+review|how\s+did\s+(?:i|today)\s+(?:do|go))$/i.test(lower))
    return { intent: { type: "brief", kind: "evening" }, confidence: 0.95, trace: ["brief:evening"] };
  if (/^(?:weekly\s+(?:review|retro|brief)|retro|how\s+was\s+(?:my|the)\s+week|week\s+in\s+review)$/i.test(lower))
    return { intent: { type: "brief", kind: "weekly" }, confidence: 0.95, trace: ["brief:weekly"] };

  // ---------- Symbiosis: council, futures, mirror, goals, undo ----------
  if (/^(?:convene\s+(?:the\s+)?council|council|deliberate|second\s+opinions?|what\s+would\s+the\s+council\s+say|challenge\s+(?:my|this)\s+(?:plan|week|day)|critique\s+(?:my|this)\s+(?:plan|week|day))(?:\s+(?:on|about)\s+(.+))?$/i.test(lower)) {
    const q = /(?:on|about)\s+(.+)$/i.exec(lower)?.[1];
    return { intent: { type: "council", question: q }, confidence: 0.95, trace: ["council"] };
  }
  if (/^(?:futures?|risks?|what'?s\s+at\s+risk|what\s+will\s+slip|simulate\s+(?:my\s+)?(?:week|futures?)|will\s+i\s+make\s+(?:my|the)\s+deadlines?|how'?s\s+(?:my|the)\s+week\s+look(?:ing)?|forecast|outlook)\??$/i.test(lower))
    return { intent: { type: "futures" }, confidence: 0.95, trace: ["futures"] };
  if (/^(?:mirror|what\s+have\s+you\s+learned(?:\s+about\s+me)?|show\s+(?:my\s+)?(?:calibration|patterns|mirror)|how\s+accurate\s+are\s+my\s+estimates|how\s+am\s+i\s+doing)\??$/i.test(lower))
    return { intent: { type: "mirror" }, confidence: 0.95, trace: ["mirror"] };
  if (/^(?:undo|undo\s+(?:that|last|the\s+last\s+(?:thing|action|change))|revert(?:\s+that)?|put\s+it\s+back)$/i.test(lower))
    return { intent: { type: "undo" }, confidence: 0.95, trace: ["undo"] };
  if (/^(?:(?:show\s+)?(?:my\s+)?goals|what\s+are\s+my\s+goals|list\s+goals)\??$/i.test(lower))
    return { intent: { type: "list_goals" }, confidence: 0.95, trace: ["list_goals"] };
  {
    const g = /^(?:(?:new|add|set|create)\s+)?goal\s*[:-]?\s+(.+)$/i.exec(text) ?? /^(?:this\s+(week|month|quarter|year)\s+i\s+want\s+to|my\s+goal\s+(?:this\s+(week|month|quarter|year)\s+)?is\s+to)\s+(.+)$/i.exec(text);
    if (g) {
      const body = stripEdges(g[g.length - 1] ?? "");
      const c = parseChrono(body, { now: ctx.now, tz: ctx.tz });
      const hz = /\b(week|month|quarter|year)\b/i.exec(text)?.[1]?.toLowerCase() as "week" | "month" | "quarter" | "year" | undefined;
      const horizon = hz ?? (c.start ? (c.start.getTime() - ctx.now.getTime() < 10 * 86400000 ? "week" : c.start.getTime() - ctx.now.getTime() < 45 * 86400000 ? "month" : c.start.getTime() - ctx.now.getTime() < 120 * 86400000 ? "quarter" : "year") : "month");
      return { intent: { type: "create_goal", title: capitalize(c.remainder || body), horizon, targetDate: c.start?.toISOString() }, confidence: 0.9, trace: ["create_goal"] };
    }
  }

  // ---------- Plan ----------
  {
    const m = /^(?:please\s+)?(?:re)?plan\s+(?:out\s+)?(?:my\s+)?(day|today|tomorrow|(?:this\s+|next\s+)?(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*|.+)$/i.exec(lower) ?? (/^(?:what\s+should\s+i\s+(?:do|work\s+on)(?:\s+(?:today|now|next|first))?|make\s+(?:me\s+)?a\s+plan|optimi[sz]e\s+(?:my\s+)?(?:day|schedule))$/i.test(lower) ? (["", "today"] as unknown as RegExpExecArray) : null);
    if (m) {
      const word = (m[1] ?? "today").replace(/^my\s+/, "");
      const c = parseChrono(word === "day" ? "today" : word, { now: ctx.now, tz: ctx.tz });
      const date = (c.start ?? ctx.now).toISOString();
      trace.push(`plan_day:${word}`);
      return { intent: { type: "plan_day", date }, confidence: c.hasDate || word === "day" ? 0.95 : 0.7, trace };
    }
  }

  // ---------- Schedule view ----------
  {
    const m = /^(?:show\s+(?:me\s+)?|what'?s\s+(?:on\s+)?(?:my\s+)?|my\s+)?(?:schedule|calendar|agenda)(?:\s+(?:for\s+)?(.+))?$/i.exec(lower);
    if (m) {
      const c = parseChrono(m[1] ?? "today", { now: ctx.now, tz: ctx.tz });
      return { intent: { type: "schedule_view", date: (c.start ?? ctx.now).toISOString() }, confidence: 0.9, trace: ["schedule_view"] };
    }
  }

  // ---------- Lists ----------
  {
    const m = /^(?:show\s+(?:me\s+)?|list\s+|what'?s\s+|what\s+is\s+|what\s+are\s+|any\s+)?(?:my\s+)?(overdue|late|open|all|done|completed|finished|someday|upcoming|today'?s?|this\s+week'?s?)?\s*(?:tasks?|todos?|to-dos?|list|items?|things\s+to\s+do)(?:\s+(?:for\s+|due\s+)?(today|tomorrow|this\s+week|overdue))?\??$/i.exec(lower);
    if (m) {
      const w = (m[1] ?? m[2] ?? "all").replace(/'s?$/, "");
      const filter =
        /overdue|late/.test(w) ? "overdue"
        : /today/.test(w) ? "today"
        : /done|completed|finished/.test(w) ? "done"
        : /someday/.test(w) ? "someday"
        : /upcoming|week|tomorrow/.test(w) ? "upcoming"
        : "all";
      return { intent: { type: "list_tasks", filter }, confidence: 0.9, trace: [`list_tasks:${filter}`] };
    }
    if (/^(?:what'?s|what\s+is|anything)\s+overdue\??$/i.test(lower)) return { intent: { type: "list_tasks", filter: "overdue" }, confidence: 0.95, trace: ["list_tasks:overdue"] };
  }

  // ---------- People ----------
  if (/^(?:who\s+(?:should|do)\s+i\s+(?:reach\s+out\s+to|call|text|message|contact|check\s+in\s+(?:with|on)|catch\s+up\s+with)(?:\s+today|\s+this\s+week)?|(?:show\s+)?(?:my\s+)?people|relationships|stale\s+(?:contacts|people)|who\s+am\s+i\s+neglecting)\??$/i.test(lower))
    return { intent: { type: "people_touch" }, confidence: 0.9, trace: ["people_touch"] };
  {
    const m = /^(?:add|new|create)\s+(?:a\s+)?(?:person|contact)\s*[:-]?\s+([A-Za-z][\w'-]+(?:\s+[A-Z][\w'-]+)?)(?:\s*[,\-–(]\s*(.+?)\)?)?$/i.exec(text) ?? /^(?:i\s+)?met\s+([A-Z][\w'-]+(?:\s+[A-Z][\w'-]+)?)(?:\s*[,\-–]\s*|\s+(?:today|yesterday)\s*[,\-–]?\s*|\s+)?(.*)$/.exec(text);
    if (m) {
      const name = stripEdges(m[1] ?? "");
      const rest = stripEdges(m[2] ?? "");
      const rel = /\b(?:my\s+)?(friend|colleague|coworker|co-worker|manager|boss|mentor|mentee|client|investor|partner|sister|brother|mom|mother|dad|father|wife|husband|cousin|neighbor|neighbour|roommate|doctor|advisor)\b/i.exec(rest);
      const cadence = /every\s+(\d+)\s+(day|week|month)s?/i.exec(rest);
      const cadenceDays = cadence ? Number(cadence[1]) * ({ day: 1, week: 7, month: 30 }[cadence[2]!.toLowerCase()] ?? 7) : undefined;
      return {
        intent: { type: "create_person", name, relation: rel?.[1]?.toLowerCase(), notes: rest || undefined, cadenceDays },
        confidence: 0.85,
        trace: ["create_person"],
      };
    }
    const lc = /^(?:(?:i\s+)?(?:just\s+)?(?:talked|spoke|chatted|caught\s+up|met|had\s+(?:coffee|lunch|dinner|a\s+call))\s+(?:to|with)\s+|log\s+(?:contact|touch)\s+(?:with\s+)?)([A-Z][\w'-]+(?:\s+[A-Z][\w'-]+)?)\b/.exec(text);
    if (lc) return { intent: { type: "log_contact", name: lc[1]! }, confidence: 0.85, trace: ["log_contact"] };
  }

  // ---------- Focus ----------
  {
    const m = /^(?:start\s+)?(?:a\s+)?(?:focus|pomodoro|deep\s+work|timer)(?:\s+(?:session|block|mode))?(?:\s+(?:for\s+)?(\d+)\s*(?:m|min|mins|minutes)?)?(?:\s+on\s+(.+))?$/i.exec(lower) ?? /^focus\s+on\s+(.+?)(?:\s+for\s+(\d+)\s*(?:m|min|mins|minutes)?)?$/i.exec(lower);
    if (m) {
      const minutes = Number(m[1] && /^\d+$/.test(m[1]) ? m[1] : m[2] && /^\d+$/.test(m[2]) ? m[2] : 25);
      const query = m[1] && !/^\d+$/.test(m[1]) ? m[1] : m[2] && !/^\d+$/.test(m[2]) ? m[2] : undefined;
      return { intent: { type: "start_focus", minutes, query }, confidence: 0.9, trace: ["start_focus"] };
    }
  }

  // ---------- Preferences ----------
  {
    const m = /^(?:set\s+)?(?:my\s+)?(name|timezone|time\s*zone|work(?:day)?\s*(?:hours|start|end)|theme|model|autonomy)\s+(?:to\s+|is\s+|=\s*)?(.+?)[.!]?$/i.exec(text);
    if (m) return { intent: { type: "set_preference", key: m[1]!.toLowerCase().replace(/\s+/g, "_"), value: stripEdges(m[2] ?? "") }, confidence: 0.8, trace: ["set_preference"] };
    const n = /^(?:call\s+me|my\s+name\s+is|i'?m|i\s+am)\s+([A-Z][\w'-]+)$/.exec(text);
    if (n) return { intent: { type: "set_preference", key: "name", value: n[1]! }, confidence: 0.85, trace: ["set_preference:name"] };
  }

  // ---------- Memory ----------
  {
    const m = /^(?:please\s+)?(?:remember|note|fyi|memo)\s*[:-]?\s*(?:that\s+)?(.+)$/i.exec(text) ?? /^(i\s+(?:prefer|like|love|hate|dislike|usually|always|never|tend\s+to|want\s+to|am\s+trying\s+to)\s+.+|my\s+(?:goal|aim|plan|intention)\s+(?:is|this\s+\w+)\s+.+|my\s+\w+(?:'s)?\s+(?:name\s+)?is\s+.+)$/i.exec(text);
    if (m && !/^remember\s+to\s/i.test(text)) {
      const body = stripEdges(m[1] ?? "");
      const kind: MemoryKind =
        /\b(goal|aim|trying\s+to|want\s+to|intend|plan\s+to|by\s+the\s+end\s+of)\b/i.test(body) ? "goal"
        : /\b(prefer|like|love|hate|dislike|usually|always|never|tend\s+to|favorite|favourite|best\s+at|worst\s+at)\b/i.test(body) ? "preference"
        : /\b(my\s+(?:wife|husband|partner|boss|manager|mom|dad|sister|brother|friend|kid|son|daughter|team)|birthday|anniversary)\b/i.test(body) ? "relationship"
        : "fact";
      const { tags } = extractTags(body);
      return { intent: { type: "remember", text: capitalize(body), kind, tags }, confidence: 0.85, trace: [`remember:${kind}`] };
    }
    const r = /^(?:what\s+do\s+you\s+(?:know|remember)\s+about\s+|recall\s+|what\s+did\s+i\s+(?:say|tell\s+you)\s+about\s+|do\s+you\s+remember\s+|what'?s\s+my\s+)(.+?)\??$/i.exec(lower);
    if (r) return { intent: { type: "recall", query: r[1]! }, confidence: 0.9, trace: ["recall"] };
    if (/^(?:what\s+do\s+you\s+know\s+about\s+me|what\s+do\s+you\s+remember|show\s+(?:my\s+)?memor(?:y|ies))\??$/i.test(lower)) return { intent: { type: "recall", query: "" }, confidence: 0.9, trace: ["recall:all"] };
    const f = /^(?:forget|delete\s+(?:the\s+)?memory\s+(?:about\s+)?|don'?t\s+remember)\s+(?:that\s+|about\s+)?(.+)$/i.exec(lower);
    if (f) return { intent: { type: "forget", query: f[1]! }, confidence: 0.85, trace: ["forget"] };
  }

  // ---------- Completion / dropping / rescheduling ----------
  {
    const m = /^(?:(?:i\s+)?(?:just\s+)?(?:finished|completed|did|done\s+with|done|complete|finish|check\s+off|tick\s+off|mark)\s+(?:the\s+|my\s+)?(?:task\s+)?)(.+?)(?:\s+(?:as\s+)?(?:done|complete|completed|finished))?$/i.exec(lower);
    const q = (x: string) => stripEdges(x).replace(/\s+(?:task|todo|item)$/i, "");
    if (m && !/^done\s*$/.test(lower)) return { intent: { type: "complete_task", query: q(m[1] ?? "") }, confidence: 0.85, trace: ["complete_task"] };
    const d = /^(?:drop|cancel|remove|delete|kill|scrap|forget\s+about)\s+(?:the\s+|my\s+)?(?:task\s+)?(.+)$/i.exec(lower);
    if (d) return { intent: { type: "drop_task", query: q(d[1] ?? "") }, confidence: 0.8, trace: ["drop_task"] };
    const r = /^(?:move|push|reschedule|snooze|defer|postpone|bump|shift)\s+(?:the\s+|my\s+)?(?:task\s+)?(.+?)\s+(?:to|until|till|for)\s+(.+)$/i.exec(lower);
    if (r) {
      const c = parseChrono(r[2]!, { now: ctx.now, tz: ctx.tz, workdayEndMin: ctx.workdayEndMin } as never);
      if (c.start) return { intent: { type: "reschedule_task", query: q(r[1] ?? ""), when: c.start.toISOString(), allDay: c.allDay }, confidence: 0.85, trace: ["reschedule_task"] };
    }
  }

  // ---------- Events ----------
  for (const lead of EVENT_LEADS) {
    const m = lead.exec(text);
    if (m) {
      const c = parseChrono(text, { now: ctx.now, tz: ctx.tz });
      if (c.start && (c.hasTime || c.hasDate)) {
        let body = c.remainder.replace(lead, "").trim();
        const kindWord = m[1];
        const { people } = extractPeople(text);
        const loc = extractLocation(body);
        body = loc.text;
        body = stripEdges(body.replace(/^(?:with|for|about|on|re:?)\s+/i, ""));
        let title = body;
        if (kindWord && !new RegExp(`\\b${kindWord}\\b`, "i").test(title)) title = capitalize(`${kindWord}${title ? " " + (people.length && !/^with/i.test(title) && people.every((p) => title.includes(p)) ? "with " + title : title) : ""}`);
        if (!title) title = capitalize(kindWord ?? "Event");
        const start = c.start;
        const end = c.end ?? new Date(start.getTime() + (c.durationMin ?? (/(lunch|dinner)/i.test(text) ? 60 : 30)) * 60000);
        trace.push("create_event");
        return {
          intent: { type: "create_event", title: capitalize(title), start: start.toISOString(), end: end.toISOString(), people, location: loc.location, recurrence: c.recurrence },
          confidence: 0.85,
          trace,
        };
      }
    }
  }

  // ---------- Tasks ----------
  {
    let isTask = false;
    for (const lead of TASK_LEADS) {
      if (lead.test(text)) {
        const m = lead.exec(text)!;
        text = m[1] ? m[1] : text.replace(lead, "");
        isTask = true;
        trace.push("task-lead");
        break;
      }
    }
    const c = parseChrono(text, { now: ctx.now, tz: ctx.tz, endOfDayMin: ctx.workdayEndMin });
    let body = c.remainder;
    const t1 = extractTags(body); body = t1.text;
    const p1 = extractProject(body); body = p1.text;
    const pr = extractPriority(body); body = pr.text;
    const en = extractEnergy(body); body = en.text;
    const { people } = extractPeople(original);
    body = stripEdges(body);

    const startsWithVerb = /^(?:call|email|text|message|ping|send|write|draft|finish|review|read|book|buy|pay|fix|update|prepare|prep|plan|clean|order|renew|submit|file|check|follow\s+up|reply|respond|schedule|research|design|build|ship|deploy|test|pick\s+up|drop\s+off|return|cancel|sign|print|pack|water|walk|feed|study|practice|apply|register|confirm|ask|talk|meet|set\s+up|organi[sz]e|sort|tidy|wash|cook|make|get|grab|take|bring|move|install|upgrade|migrate|refactor|debug|investigate|outline|edit|publish|post|share|record|upload|download|backup|back\s+up|print|mail|ship)\b/i.test(body);
    const eventish = looksLikeEvent(original) && c.hasTime && !isTask;

    if (eventish) {
      const start = c.start!;
      const end = c.end ?? new Date(start.getTime() + (c.durationMin ?? 30) * 60000);
      return {
        intent: { type: "create_event", title: capitalize(body || "Event"), start: start.toISOString(), end: end.toISOString(), people, recurrence: c.recurrence },
        confidence: 0.7,
        trace: [...trace, "create_event:heuristic"],
      };
    }

    if (isTask || startsWithVerb || c.hasDate || c.hasTime || c.recurrence || t1.tags.length || pr.priority) {
      const title = capitalize(body || original);
      const pinned = c.hasTime && !c.isDeadline && !c.recurrence ? c.start : undefined;
      let due = c.start && (c.isDeadline || c.allDay || !pinned) ? c.start : undefined;
      if (c.recurrence) due = nextOccurrence(c.recurrence, ctx.now, ctx.tz) ?? due;
      const confidence = isTask ? 0.9 : startsWithVerb || c.recurrence ? 0.8 : 0.6;
      return {
        intent: {
          type: "create_task",
          title,
          due: due?.toISOString(),
          pinnedStart: pinned?.toISOString(),
          estimateMin: c.durationMin,
          priority: pr.priority,
          energy: en.energy,
          recurrence: c.recurrence,
          tags: t1.tags,
          people,
          project: p1.project,
        },
        confidence,
        trace: [...trace, "create_task"],
      };
    }
  }

  return { intent: { type: "chat", text: original }, confidence: 0.3, trace: ["chat:fallback"] };
}
