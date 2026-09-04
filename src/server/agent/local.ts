import { uid } from "../ids.js";
/**
 * Local Mind — the brain that runs when there's no model.
 *
 * It's not a fallback that apologizes; it's a real assistant with a smaller
 * vocabulary. Intent parsing → tool execution → a short, human reply plus
 * cards. Everything it does, the Claude brain can also do; the reverse isn't
 * true, and that's fine.
 */
import type { ToolRegistry, ToolResult } from "./tools.js";
import { parseIntent, extractCandidates, type AgentEvent, type Card, type Intent } from "../../core/index.js";
import type { Services } from "../services.js";

const HELP = `Here's what I understand without a model:
- "call mom tomorrow at 5", "submit report by friday eod", "every weekday 8am journal"
- "meeting with Sam next tue 3pm for 45 min", "lunch with Dana friday 12-1"
- "plan my day", "plan tomorrow", "what's on today", "evening review", "weekly retro"
- "done with the report", "move dentist to next week", "drop the newsletter task"
- "remember I prefer deep work before noon", "what do you know about my goals", "forget that"
- "met Priya, colleague from design, every 2 weeks", "talked to Sam", "who should I reach out to"
- "focus for 50 on the essay", "what's overdue", "my name is Will", "timezone Europe/Berlin"
- "goal: ship v1 by October", "my goals", "what's at risk", "convene the council", "mirror", "undo"
Add an Anthropic API key in Settings and I get a lot smarter.`;

function pick<T>(arr: T[], seed: number): T {
  return arr[seed % arr.length]!;
}

/** "add X, and what's overdue?" → two intents, when the tail is unmistakably its own command. */
export function splitCompound(message: string, ctx: { now: Date; tz: string; workdayEndMin?: number }): string[] {
  const m = /^(.*?[^,]),?\s+(?:and|then|also)\s+(.+)$/i.exec(message.trim());
  if (!m) return [message];
  const head = m[1]!.trim();
  const tail = m[2]!.trim();
  const t = parseIntent(tail, ctx);
  const h = parseIntent(head, ctx);
  const standalone = new Set(["list_tasks", "brief", "plan_day", "schedule_view", "people_touch", "recall", "start_focus", "help", "futures", "council", "mirror", "list_goals"]);
  if (t.confidence >= 0.9 && standalone.has(t.intent.type) && h.intent.type !== "chat") return [head, tail];
  return [message];
}

const ID_RE = /\s*\[(?:tsk|evt|mem|per|ndg)_[a-z0-9]+\]/g;

export async function* runLocal(message: string, tools: ToolRegistry, svc: Services, now = new Date()): AsyncGenerator<AgentEvent> {
  const prefs = svc.prefs();
  const ctx = { now, tz: prefs.timezone, workdayEndMin: prefs.workdayEndMin };
  const parts = splitCompound(message, ctx);
  if (parts.length > 1) {
    const turnId = uid("trn");
    yield { type: "start", turnId, mode: "local" };
    let text = "";
    const cards: Card[] = [];
    for (const part of parts) {
      for await (const ev of runLocalOne(part, tools, svc, now)) {
        if (ev.type === "card") { cards.push(ev.card); yield ev; }
        else if (ev.type === "mutation") yield ev;
        else if (ev.type === "done") text += (text ? "\n" : "") + ev.text;
      }
    }
    if (text) yield { type: "text", delta: text };
    yield { type: "done", turnId, text, cards };
    return;
  }
  yield* runLocalOne(message, tools, svc, now);
}

async function* runLocalOne(message: string, tools: ToolRegistry, svc: Services, now: Date): AsyncGenerator<AgentEvent> {
  const turnId = uid("trn");
  yield { type: "start", turnId, mode: "local" };
  const prefs = svc.prefs();
  const { intent, confidence } = parseIntent(message, { now, tz: prefs.timezone, workdayEndMin: prefs.workdayEndMin });
  const seed = message.length + now.getMinutes();

  const call = (name: keyof ToolRegistry & string, input: Record<string, unknown>): ToolResult => {
    const t = tools[name];
    if (!t) return { text: `Unknown tool ${name}`, ok: false };
    return t.run(input, now);
  };

  let text = "";
  const cards: Card[] = [];
  const mutated = new Set<string>();
  const absorb = (r: ToolResult, lead = "") => {
    const first = r.text.split("\n")[0] ?? "";
    const line = (r.ok === false ? r.text : first).replace(ID_RE, "");
    text += (text ? "\n" : "") + lead + line;
    if (r.cards) cards.push(...r.cards);
    for (const m of r.mutated ?? []) mutated.add(m);
  };

  const i: Intent = intent;
  switch (i.type) {
    case "help":
      text = HELP;
      break;
    case "brief":
      absorb(call("get_brief", { kind: i.kind }), i.kind === "morning" ? pick(["Here's your morning.", "Here's the day.", "Morning. Here's the shape of things."], seed) : i.kind === "evening" ? "Here's how the day went." : "Here's the week.");
      break;
    case "plan_day":
      absorb(call("plan_day", { date: i.date }), pick(["Planned it.", "Here's a plan that respects your energy curve.", "Done. Every block has a reason; tap one to see it."], seed));
      break;
    case "schedule_view":
      absorb(call("list_events", { day: i.date }));
      break;
    case "list_tasks":
      absorb(call("list_tasks", { filter: i.filter }));
      break;
    case "create_task": {
      const r = call("create_task", { title: i.title, due: i.due, pinned_start: i.pinnedStart, estimate_min: i.estimateMin, priority: i.priority, energy: i.energy, tags: i.tags, project: i.project, people: i.people, recurrence: i.recurrence ? JSON.stringify(i.recurrence) : undefined });
      // recurrence passed as JSON isn't parsed by chrono; patch it directly
      if (i.recurrence && r.cards?.[0]?.type === "tasks") {
        const t = r.cards[0].tasks[0]!;
        const fixed = svc.repo.updateTask(t.id, { recurrence: i.recurrence });
        if (fixed) r.cards[0].tasks[0] = fixed;
      }
      absorb(r, confidence < 0.7 ? "I read that as a task — say \"drop it\" if not. " : pick(["Got it.", "Added.", "On the list."], seed) + " ");
      break;
    }
    case "create_event":
      absorb(call("create_event", { title: i.title, start: i.start, end: i.end, people: i.people, location: i.location }), pick(["Scheduled.", "It's on the calendar.", "Booked."], seed) + " ");
      break;
    case "complete_task":
      absorb(call("complete_task", { query: i.query }), pick(["Nice.", "One down.", "✓"], seed) + " ");
      break;
    case "drop_task":
      absorb(call("drop_task", { query: i.query }), "");
      break;
    case "reschedule_task": {
      const r = call("update_task", i.allDay ? { query: i.query, due: i.when, clear_pinned: true } : { query: i.query, pinned_start: i.when });
      if (r.ok === false) {
        const ev = call("update_event", { query: i.query, start: i.when });
        absorb(ev, ev.ok === false ? "" : "Moved the event. ");
      } else absorb(r, "Moved. ");
      break;
    }
    case "remember":
      absorb(call("remember", { text: i.text, kind: i.kind, tags: i.tags, source: "stated", evidence: message }), "");
      break;
    case "recall":
      absorb(call("recall", { query: i.query }));
      break;
    case "forget":
      absorb(call("forget", { query: i.query }), "");
      break;
    case "create_person":
      absorb(call("upsert_person", { name: i.name, relation: i.relation, notes: i.notes, cadence_days: i.cadenceDays }), "");
      break;
    case "log_contact":
      absorb(call("log_contact", { name: i.name }), "");
      break;
    case "people_touch":
      absorb(call("list_people", { stale_only: true }));
      break;
    case "start_focus":
      absorb(call("start_focus", { minutes: i.minutes, task_query: i.query }), "");
      break;
    case "set_preference":
      absorb(call("set_preference", { key: i.key, value: i.value }), "");
      break;
    case "council":
      absorb(call("convene_council", { question: i.question }), "The council has met. ");
      break;
    case "futures":
      absorb(call("assess_risk", {}), "");
      break;
    case "mirror":
      absorb(call("show_mirror", {}), "");
      break;
    case "undo":
      absorb(call("undo_last", {}), "");
      break;
    case "create_goal":
      absorb(call("create_goal", { title: i.title, horizon: i.horizon, target_date: i.targetDate }), "");
      break;
    case "list_goals":
      absorb(call("list_goals", {}), "");
      break;
    case "chat": {
      // Not a command. Mine it for memories, then answer honestly.
      const cands = extractCandidates(message, "stated");
      for (const c of cands) absorb(call("remember", { ...c, source: c.source }), "Noted. ");
      if (!cands.length) {
        text = pick([
          "I'm running without a model right now, so I'm best with concrete asks: tasks, events, plans, memory, people. Try \"plan my day\" or add an API key in Settings for open conversation.",
          "Without a model I can't chat freely, but I can run your day. Say \"help\" to see what I understand, or add an Anthropic key in Settings.",
        ], seed);
      }
      break;
    }
  }

  for (const c of cards) yield { type: "card", card: c };
  for (const m of mutated) yield { type: "mutation", entity: m as never };
  if (text) yield { type: "text", delta: text };
  yield { type: "done", turnId, text, cards };
}
