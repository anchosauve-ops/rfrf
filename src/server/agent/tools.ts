/**
 * Tools — the single capability surface for both brains.
 *
 * Claude calls these through tool use; the Local Mind calls them directly
 * after parsing intent. Every tool returns text (for the transcript and the
 * model) plus optional cards (for the UI) and the entities it mutated.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { Services } from "../services.js";
import {
  parseChrono,
  recall,
  findDuplicate,
  nextOccurrence,
  describeRule,
  dayKey,
  formatTime,
  formatDate,
  startOfDay,
  addDays,
  isValidTimeZone,
  type Card,
  type Energy,
  type Memory,
  type Priority,
  type RRule,
  type Task,
  type Event,
  type Goal,
} from "../../core/index.js";

export type MutatedEntity = "task" | "event" | "memory" | "person" | "nudge" | "plan" | "prefs" | "goal" | "ledger";

export interface ToolResult {
  text: string;
  cards?: Card[];
  mutated?: MutatedEntity[];
  ok?: boolean;
}

type Input = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && !Number.isNaN(Number(v)) ? Number(v) : undefined);
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function fmtTask(t: Task, tz: string): string {
  const bits = [t.title];
  if (t.due) bits.push(`due ${formatDate(new Date(t.due), tz)}${t.due.slice(11, 16) !== "00:00" ? " " + formatTime(new Date(t.due), tz) : ""}`);
  if (t.pinnedStart) bits.push(`at ${formatDate(new Date(t.pinnedStart), tz)} ${formatTime(new Date(t.pinnedStart), tz)}`);
  if (t.recurrence) bits.push(describeRule(t.recurrence));
  if (t.estimateMin) bits.push(`~${t.estimateMin}m`);
  if (t.priority <= 2) bits.push(t.priority === 1 ? "critical" : "important");
  return bits.join(" · ");
}

export function buildTools(svc: Services) {
  const repo = svc.repo;
  const tz = () => svc.prefs().timezone;

  const resolveTask = (input: Input): Task | undefined => {
    const id = str(input.id);
    if (id) return repo.getTask(id);
    const q = str(input.query) ?? str(input.title);
    return q ? repo.findTask(q) : undefined;
  };

  const resolveWhen = (v: unknown, now: Date): Date | undefined => {
    const t = str(v);
    if (!t) return undefined;
    const iso = new Date(t);
    if (!Number.isNaN(iso.getTime()) && /\d{4}-\d{2}-\d{2}/.test(t)) return iso;
    const c = parseChrono(t, { now, tz: tz(), endOfDayMin: svc.prefs().workdayEndMin });
    return c.start;
  };

  const linkPeople = (names: string[], title?: string): string[] => {
    const ids = new Set<string>();
    for (const name of names) {
      const p = repo.findPerson(name) ?? repo.createPerson({ name });
      ids.add(p.id);
    }
    if (title) {
      // link people we already know when their name appears in the title ("send the deck to Priya")
      for (const p of repo.listPeople()) {
        const first = p.name.split(/\s+/)[0]!;
        if (first.length >= 3 && new RegExp(`(^|[^\\w])${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w]|$)`, "i").test(title)) ids.add(p.id);
      }
    }
    return [...ids];
  };

  const tools: Record<string, { def: Anthropic.Tool; run: (input: Input, now: Date) => ToolResult }> = {
    create_task: {
      def: {
        name: "create_task",
        description:
          "Create a task. Use `due` for deadlines ('by Friday') and `pinned_start` when the person named a specific time to do it ('call mom at 5'). Times may be ISO-8601 or natural language; natural language is resolved in the person's timezone.",
        input_schema: {
          type: "object",
          properties: {
            title: { type: "string" },
            notes: { type: "string" },
            due: { type: "string", description: "Deadline, ISO or natural language" },
            pinned_start: { type: "string", description: "Fixed start time, ISO or natural language" },
            estimate_min: { type: "integer", description: "Estimated minutes (default 30)" },
            priority: { type: "integer", description: "1 critical, 2 important, 3 normal, 4 someday" },
            energy: { type: "string", enum: ["deep", "light", "admin", "social"] },
            tags: { type: "array", items: { type: "string" } },
            project: { type: "string" },
            people: { type: "array", items: { type: "string" }, description: "Names of people involved" },
            recurrence: { type: "string", description: "Natural language, e.g. 'every weekday at 8am'" },
            goal: { type: "string", description: "Title or id of the goal this serves" },
          },
          required: ["title"],
        },
      },
      run: (input, now) => {
        const title = str(input.title);
        if (!title) return { text: "A task needs a title.", ok: false };
        let recurrence: RRule | undefined;
        const recText = str(input.recurrence);
        if (recText) recurrence = parseChrono(recText, { now, tz: tz() }).recurrence;
        let due = resolveWhen(input.due, now);
        if (recurrence && !due) due = nextOccurrence(recurrence, now, tz()) ?? undefined;
        const t = repo.createTask({
          title,
          notes: str(input.notes),
          due: due?.toISOString(),
          pinnedStart: resolveWhen(input.pinned_start, now)?.toISOString(),
          estimateMin: num(input.estimate_min),
          priority: (num(input.priority) as Priority | undefined) ?? 3,
          energy: (str(input.energy) as Energy | undefined) ?? guessEnergy(title),
          tags: arr(input.tags),
          project: str(input.project),
          peopleIds: linkPeople(arr(input.people), title),
          recurrence,
          goalId: str(input.goal) ? (repo.getGoal(str(input.goal)!) ?? repo.findGoal(str(input.goal)!))?.id : undefined,
          source: "agent",
        });
        return { text: `Added: ${fmtTask(t, tz())} [${t.id}]`, cards: [{ type: "tasks", title: "Added", tasks: [t] }], mutated: ["task"] };
      },
    },

    update_task: {
      def: {
        name: "update_task",
        description: "Update a task found by id or fuzzy title query. Only provided fields change. Use to reschedule, re-prioritize, re-estimate, snooze, or retitle.",
        input_schema: {
          type: "object",
          properties: {
            id: { type: "string" },
            query: { type: "string", description: "Fuzzy title match if id unknown" },
            title: { type: "string" },
            notes: { type: "string" },
            due: { type: "string" },
            pinned_start: { type: "string" },
            snoozed_until: { type: "string" },
            estimate_min: { type: "integer" },
            priority: { type: "integer" },
            energy: { type: "string", enum: ["deep", "light", "admin", "social"] },
            clear_due: { type: "boolean" },
            clear_pinned: { type: "boolean" },
          },
        },
      },
      run: (input, now) => {
        const t = resolveTask(input);
        if (!t) return { text: `I couldn't find a task matching "${str(input.query) ?? str(input.id) ?? ""}".`, ok: false };
        const patch: Partial<Task> = {};
        const newTitle = str(input.title);
        if (newTitle && newTitle !== str(input.query)) patch.title = newTitle;
        if (str(input.notes)) patch.notes = str(input.notes);
        if (input.due !== undefined) patch.due = resolveWhen(input.due, now)?.toISOString();
        if (input.pinned_start !== undefined) patch.pinnedStart = resolveWhen(input.pinned_start, now)?.toISOString();
        if (input.snoozed_until !== undefined) patch.snoozedUntil = resolveWhen(input.snoozed_until, now)?.toISOString();
        if (num(input.estimate_min)) patch.estimateMin = num(input.estimate_min);
        if (num(input.priority)) patch.priority = num(input.priority) as Priority;
        if (str(input.energy)) patch.energy = str(input.energy) as Energy;
        if (input.clear_due) patch.due = undefined;
        if (input.clear_pinned) patch.pinnedStart = undefined;
        const next = repo.updateTask(t.id, patch)!;
        return { text: `Updated: ${fmtTask(next, tz())}`, cards: [{ type: "tasks", title: "Updated", tasks: [next] }], mutated: ["task"] };
      },
    },

    complete_task: {
      def: {
        name: "complete_task",
        description: "Mark a task done, by id or fuzzy title. Recurring tasks roll forward to their next occurrence. Pass actual_min when the person says how long it really took; it teaches the calibration model.",
        input_schema: { type: "object", properties: { id: { type: "string" }, query: { type: "string" }, actual_min: { type: "integer", description: "How long it actually took" } } },
      },
      run: (input, now) => {
        const t = resolveTask(input);
        if (!t) return { text: `No open task matches "${str(input.query) ?? ""}".`, ok: false };
        if (t.recurrence) {
          const next = nextOccurrence(t.recurrence, now, tz());
          const rolled = repo.updateTask(t.id, { due: next?.toISOString(), pinnedStart: undefined });
          const doneCopy = repo.createTask({ ...t, id: undefined, status: "done", completedAt: now.toISOString(), recurrence: undefined, source: t.source });
          svc.recordOutcome(doneCopy, now, num(input.actual_min));
          return { text: `Done: ${t.title}. Next one ${next ? formatDate(next, tz()) : "scheduled"}.`, cards: rolled ? [{ type: "tasks", title: "Rolled forward", tasks: [rolled] }] : undefined, mutated: ["task"] };
        }
        const done = repo.updateTask(t.id, { status: "done" })!;
        svc.recordOutcome(done, now, num(input.actual_min));
        const linked = repo.listPeople().filter((p) => t.peopleIds.includes(p.id));
        for (const p of linked) if (t.energy === "social") repo.updatePerson(p.id, { lastContactAt: now.toISOString() });
        return { text: `Done: ${t.title}.`, cards: [{ type: "tasks", title: "Completed", tasks: [done] }], mutated: ["task", ...(linked.length ? (["person"] as const) : [])] };
      },
    },

    drop_task: {
      def: { name: "drop_task", description: "Drop (cancel) a task without completing it.", input_schema: { type: "object", properties: { id: { type: "string" }, query: { type: "string" } } } },
      run: (input) => {
        const t = resolveTask(input);
        if (!t) return { text: `No open task matches "${str(input.query) ?? ""}".`, ok: false };
        repo.updateTask(t.id, { status: "dropped" });
        return { text: `Dropped: ${t.title}.`, mutated: ["task"] };
      },
    },

    list_tasks: {
      def: {
        name: "list_tasks",
        description: "List tasks with a filter.",
        input_schema: { type: "object", properties: { filter: { type: "string", enum: ["today", "overdue", "upcoming", "all", "someday", "done"] }, limit: { type: "integer" } } },
      },
      run: (input, now) => {
        const filter = str(input.filter) ?? "all";
        const limit = num(input.limit) ?? 25;
        const z = tz();
        const day0 = startOfDay(now, z);
        const day1 = addDays(day0, 1, z);
        const week = addDays(day0, 7, z);
        let tasks = filter === "done" ? repo.listTasks({ status: "done" }) : repo.listTasks({ status: "open" });
        if (filter === "today") tasks = tasks.filter((t) => (t.due && new Date(t.due) < day1) || (t.pinnedStart && new Date(t.pinnedStart) >= day0 && new Date(t.pinnedStart) < day1) || (t.plannedStart && dayKey(new Date(t.plannedStart), z) === dayKey(now, z)));
        else if (filter === "overdue") tasks = tasks.filter((t) => t.due && new Date(t.due) < now);
        else if (filter === "upcoming") tasks = tasks.filter((t) => t.due && new Date(t.due) >= day1 && new Date(t.due) < week);
        else if (filter === "someday") tasks = tasks.filter((t) => t.priority === 4 || (!t.due && !t.pinnedStart));
        tasks = tasks.slice(0, limit);
        const title = { today: "Today", overdue: "Overdue", upcoming: "This week", all: "Open tasks", someday: "Someday", done: "Done" }[filter] ?? "Tasks";
        if (!tasks.length) return { text: `${title}: nothing.`, cards: [] };
        return { text: `${title} (${tasks.length}):\n${tasks.map((t) => `- ${fmtTask(t, z)} [${t.id}]`).join("\n")}`, cards: [{ type: "tasks", title, tasks }] };
      },
    },

    create_event: {
      def: {
        name: "create_event",
        description: "Create a calendar event. Times may be ISO or natural language. If end is omitted, defaults to 30 minutes (60 for meals).",
        input_schema: {
          type: "object",
          properties: {
            title: { type: "string" },
            start: { type: "string" },
            end: { type: "string" },
            duration_min: { type: "integer" },
            kind: { type: "string", enum: ["meeting", "focus", "personal", "travel", "ritual"] },
            location: { type: "string" },
            notes: { type: "string" },
            people: { type: "array", items: { type: "string" } },
            all_day: { type: "boolean" },
          },
          required: ["title", "start"],
        },
      },
      run: (input, now) => {
        const title = str(input.title);
        const start = resolveWhen(input.start, now);
        if (!title || !start) return { text: "An event needs a title and a start time I can resolve.", ok: false };
        let end = resolveWhen(input.end, now);
        if (!end) {
          const c = str(input.start) ? parseChrono(str(input.start)!, { now, tz: tz() }) : undefined;
          const dur = num(input.duration_min) ?? c?.durationMin ?? (/lunch|dinner|breakfast|coffee/i.test(title) ? 60 : 30);
          end = c?.end ?? new Date(start.getTime() + dur * 60000);
        }
        const kind = (str(input.kind) as Event["kind"] | undefined) ?? (/focus|deep work|writing|block/i.test(title) ? "focus" : /lunch|dinner|gym|workout|dentist|doctor|family|kids|date/i.test(title) ? "personal" : "meeting");
        const e = repo.createEvent({ title, start: start.toISOString(), end: end.toISOString(), allDay: !!input.all_day, kind, location: str(input.location), notes: str(input.notes), peopleIds: linkPeople(arr(input.people), title), source: "agent" });
        return { text: `Scheduled: ${e.title} ${formatDate(start, tz())} ${formatTime(start, tz())}–${formatTime(end, tz())}${e.location ? ` at ${e.location}` : ""} [${e.id}]`, cards: [{ type: "events", title: "Scheduled", events: [e] }], mutated: ["event", "plan"] };
      },
    },

    update_event: {
      def: {
        name: "update_event",
        description: "Move, rename or delete an event found by id or fuzzy title.",
        input_schema: { type: "object", properties: { id: { type: "string" }, query: { type: "string" }, title: { type: "string" }, start: { type: "string" }, end: { type: "string" }, location: { type: "string" }, delete: { type: "boolean" } } },
      },
      run: (input, now) => {
        const e = (str(input.id) && repo.getEvent(str(input.id)!)) || (str(input.query) ? repo.findEvent(str(input.query)!, addDays(startOfDay(now, tz()), -1, tz()).toISOString()) : undefined);
        if (!e) return { text: `No event matches "${str(input.query) ?? ""}".`, ok: false };
        if (input.delete) {
          repo.deleteEvent(e.id);
          return { text: `Removed: ${e.title}.`, mutated: ["event", "plan"] };
        }
        const patch: Partial<Event> = {};
        if (str(input.title)) patch.title = str(input.title);
        if (str(input.location)) patch.location = str(input.location);
        const s = resolveWhen(input.start, now);
        const en = resolveWhen(input.end, now);
        if (s) {
          const dur = new Date(e.end).getTime() - new Date(e.start).getTime();
          patch.start = s.toISOString();
          patch.end = (en ?? new Date(s.getTime() + dur)).toISOString();
        } else if (en) patch.end = en.toISOString();
        const next = repo.updateEvent(e.id, patch)!;
        return { text: `Updated: ${next.title} → ${formatDate(new Date(next.start), tz())} ${formatTime(new Date(next.start), tz())}`, cards: [{ type: "events", title: "Updated", events: [next] }], mutated: ["event", "plan"] };
      },
    },

    list_events: {
      def: { name: "list_events", description: "List events in a range (natural language or ISO). Defaults to today.", input_schema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, day: { type: "string", description: "A single day, e.g. 'tomorrow'" } } } },
      run: (input, now) => {
        const z = tz();
        let from = resolveWhen(input.from, now);
        let to = resolveWhen(input.to, now);
        const day = resolveWhen(input.day, now);
        if (day) { from = startOfDay(day, z); to = addDays(from, 1, z); }
        from ??= startOfDay(now, z);
        to ??= addDays(from, 1, z);
        const events = repo.listEvents({ from: from.toISOString(), to: to.toISOString() });
        const title = `Schedule ${formatDate(from, z)}`;
        if (!events.length) return { text: `${title}: clear.`, cards: [] };
        return { text: `${title}:\n${events.map((e) => `- ${e.allDay ? "all day" : `${formatTime(new Date(e.start), z)}–${formatTime(new Date(e.end), z)}`} ${e.title} [${e.id}]`).join("\n")}`, cards: [{ type: "events", title, events }] };
      },
    },

    remember: {
      def: {
        name: "remember",
        description: "Store something about the person: a fact, preference, goal, relationship, insight or episode. Include `evidence` (their words) so they can audit it. Near-duplicates are merged.",
        input_schema: {
          type: "object",
          properties: {
            text: { type: "string", description: "Third-person-free, e.g. 'Prefers deep work before noon'" },
            kind: { type: "string", enum: ["fact", "preference", "goal", "relationship", "insight", "episode"] },
            importance: { type: "number", description: "0..1" },
            confidence: { type: "number", description: "0..1" },
            source: { type: "string", enum: ["stated", "inferred"] },
            evidence: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            pinned: { type: "boolean" },
          },
          required: ["text"],
        },
      },
      run: (input) => {
        const text = str(input.text);
        if (!text) return { text: "Nothing to remember.", ok: false };
        const dup = findDuplicate(repo.listMemories(), text);
        if (dup) {
          const merged = repo.updateMemory(dup.id, { text: text.length > dup.text.length ? text : dup.text, confidence: Math.min(1, dup.confidence + 0.05), importance: Math.max(dup.importance, num(input.importance) ?? dup.importance) })!;
          return { text: `Already knew something close; reinforced it: "${merged.text}"`, cards: [{ type: "memories", title: "Reinforced", memories: [merged] }], mutated: ["memory"] };
        }
        const m = repo.createMemory({ text, kind: (str(input.kind) as Memory["kind"]) ?? "fact", importance: num(input.importance) ?? 0.6, confidence: num(input.confidence) ?? (str(input.source) === "inferred" ? 0.7 : 0.9), source: (str(input.source) as Memory["source"]) ?? "stated", evidence: str(input.evidence), tags: arr(input.tags), pinned: !!input.pinned });
        return { text: `Remembered (${m.kind}): ${m.text}`, cards: [{ type: "memories", title: "Remembered", memories: [m] }], mutated: ["memory"] };
      },
    },

    recall: {
      def: { name: "recall", description: "Search memory. Empty query returns the strongest memories overall.", input_schema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } } } },
      run: (input, now) => {
        const q = str(input.query) ?? "";
        const hits = recall(repo.listMemories(), q, { now, limit: num(input.limit) ?? 8 });
        repo.touchMemories(hits.map((h) => h.item.id));
        if (!hits.length) return { text: q ? `Nothing in memory about "${q}".` : "Memory is empty so far.", cards: [] };
        return { text: `Memory${q ? ` for "${q}"` : ""}:\n${hits.map((h) => `- (${h.item.kind}, ${h.item.source}, ${Math.round(h.item.confidence * 100)}%) ${h.item.text}`).join("\n")}`, cards: [{ type: "memories", title: q ? `About "${q}"` : "What I know", memories: hits.map((h) => h.item) }] };
      },
    },

    forget: {
      def: { name: "forget", description: "Delete a memory by id, or the best match for a query.", input_schema: { type: "object", properties: { id: { type: "string" }, query: { type: "string" } } } },
      run: (input, now) => {
        const id = str(input.id);
        const m = id ? repo.getMemory(id) : recall(repo.listMemories(), str(input.query) ?? "", { now, limit: 1 })[0]?.item;
        if (!m) return { text: "Couldn't find that memory.", ok: false };
        repo.deleteMemory(m.id);
        return { text: `Forgot: "${m.text}"`, mutated: ["memory"] };
      },
    },

    upsert_person: {
      def: {
        name: "upsert_person",
        description: "Create or update a person. cadence_days = how often they want to be in touch.",
        input_schema: { type: "object", properties: { name: { type: "string" }, relation: { type: "string" }, notes: { type: "string" }, cadence_days: { type: "integer" }, birthday: { type: "string", description: "MM-DD" }, tags: { type: "array", items: { type: "string" } } }, required: ["name"] },
      },
      run: (input) => {
        const name = str(input.name);
        if (!name) return { text: "A person needs a name.", ok: false };
        const existing = repo.findPerson(name);
        const patch = { relation: str(input.relation), notes: str(input.notes), cadenceDays: num(input.cadence_days), birthday: str(input.birthday), tags: arr(input.tags) };
        const p = existing
          ? repo.updatePerson(existing.id, { ...(patch.relation && { relation: patch.relation }), ...(patch.notes && { notes: existing.notes ? `${existing.notes}\n${patch.notes}` : patch.notes }), ...(patch.cadenceDays && { cadenceDays: patch.cadenceDays }), ...(patch.birthday && { birthday: patch.birthday }), ...(patch.tags.length && { tags: [...new Set([...existing.tags, ...patch.tags])] }) })!
          : repo.createPerson({ name, ...patch, tags: patch.tags });
        return { text: `${existing ? "Updated" : "Added"} ${p.name}${p.relation ? ` (${p.relation})` : ""}${p.cadenceDays ? `, every ${p.cadenceDays} days` : ""}.`, cards: [{ type: "people", title: existing ? "Updated" : "New person", people: [p] }], mutated: ["person"] };
      },
    },

    log_contact: {
      def: { name: "log_contact", description: "Record that the person was just in touch with someone (resets their cadence clock).", input_schema: { type: "object", properties: { name: { type: "string" }, note: { type: "string" } }, required: ["name"] } },
      run: (input, now) => {
        const name = str(input.name);
        if (!name) return { text: "Who?", ok: false };
        const p = repo.findPerson(name) ?? repo.createPerson({ name });
        const note = str(input.note);
        const next = repo.updatePerson(p.id, { lastContactAt: now.toISOString(), ...(note && { notes: p.notes ? `${p.notes}\n${now.toISOString().slice(0, 10)}: ${note}` : `${now.toISOString().slice(0, 10)}: ${note}` }) })!;
        return { text: `Logged contact with ${next.name}.`, cards: [{ type: "people", title: "In touch", people: [next] }], mutated: ["person"] };
      },
    },

    list_people: {
      def: { name: "list_people", description: "List people; stale_only shows those past their cadence.", input_schema: { type: "object", properties: { stale_only: { type: "boolean" } } } },
      run: (input, now) => {
        if (input.stale_only) {
          const stale = svc.stalePeople(now);
          if (!stale.length) return { text: "Nobody is drifting. Nice.", cards: [] };
          return { text: `Reach out to:\n${stale.map((s) => `- ${s.person.name}${s.person.relation ? ` (${s.person.relation})` : ""} — ${s.overdueDays ? `${s.overdueDays}d past cadence` : "due now"}`).join("\n")}`, cards: [{ type: "people", title: "People drifting", people: stale.map((s) => s.person) }] };
        }
        const people = repo.listPeople();
        return { text: people.length ? `People (${people.length}): ${people.map((p) => p.name).join(", ")}` : "No people yet.", cards: people.length ? [{ type: "people", title: "People", people }] : [] };
      },
    },

    plan_day: {
      def: { name: "plan_day", description: "Build (or rebuild) a time-blocked plan for a day from open tasks, events and the person's energy curve.", input_schema: { type: "object", properties: { date: { type: "string", description: "'today', 'tomorrow', a weekday, or YYYY-MM-DD" } } } },
      run: (input, now) => {
        const when = resolveWhen(input.date, now) ?? now;
        const plan = svc.plan(dayKey(when, tz()), now);
        const tasks = plan.blocks.filter((b) => b.kind === "task").length;
        return { text: `Planned ${plan.date}: ${tasks} task block${tasks === 1 ? "" : "s"}, ${plan.stats.loadPct}% load, ${plan.unscheduled.length} left out.\n${plan.blocks.filter((b) => b.kind !== "buffer").map((b) => `- ${formatTime(new Date(b.start), tz())} ${b.title}${b.reason ? ` (${b.reason})` : ""}`).join("\n")}`, cards: [{ type: "plan", plan }], mutated: ["plan", "task"] };
      },
    },

    get_brief: {
      def: { name: "get_brief", description: "Compose the morning brief, evening review or weekly retro from live data.", input_schema: { type: "object", properties: { kind: { type: "string", enum: ["morning", "evening", "weekly"] } } } },
      run: (input, now) => {
        const brief = svc.brief((str(input.kind) as "morning" | "evening" | "weekly") ?? "morning", now);
        return { text: `${brief.greeting} ${brief.headline}\n${brief.sections.map((s) => `${s.title}: ${s.lines.join("; ")}`).join("\n")}`, cards: [{ type: "brief", brief }] };
      },
    },

    start_focus: {
      def: { name: "start_focus", description: "Start a focus timer, optionally on a task.", input_schema: { type: "object", properties: { minutes: { type: "integer" }, task_query: { type: "string" } } } },
      run: (input) => {
        const minutes = num(input.minutes) ?? 25;
        const t = str(input.task_query) ? repo.findTask(str(input.task_query)!) : undefined;
        const title = t?.title ?? str(input.task_query) ?? "Focus";
        repo.startFocus({ taskId: t?.id, title, minutes });
        return { text: `Focus started: ${title}, ${minutes} minutes.`, cards: [{ type: "focus", taskId: t?.id, title, minutes }] };
      },
    },

    show_card: {
      def: {
        name: "show_card",
        description: "Render a UI card instead of plain text: a checklist, a decision with options, or metrics. Use for structured answers.",
        input_schema: {
          type: "object",
          properties: {
            checklist: { type: "object", properties: { title: { type: "string" }, items: { type: "array", items: { type: "string" } } } },
            decision: { type: "object", properties: { question: { type: "string" }, options: { type: "array", items: { type: "object", properties: { label: { type: "string" }, rationale: { type: "string" }, command: { type: "string", description: "What to run if chosen, phrased as a message to you" } } } } } },
            metrics: { type: "object", properties: { title: { type: "string" }, items: { type: "array", items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" }, hint: { type: "string" } } } } } },
          },
        },
      },
      run: (input) => {
        const cards: Card[] = [];
        const cl = input.checklist as { title?: string; items?: string[] } | undefined;
        if (cl?.items?.length) cards.push({ type: "checklist", title: cl.title ?? "Checklist", items: cl.items.map((text) => ({ text, done: false })) });
        const d = input.decision as { question?: string; options?: { label: string; rationale?: string; command?: string }[] } | undefined;
        if (d?.options?.length) cards.push({ type: "decision", question: d.question ?? "Which way?", options: d.options.map((o) => ({ label: o.label, rationale: o.rationale ?? "", command: o.command })) });
        const m = input.metrics as { title?: string; items?: { label: string; value: string; hint?: string }[] } | undefined;
        if (m?.items?.length) cards.push({ type: "metrics", title: m.title, items: m.items });
        return { text: cards.length ? "(card rendered)" : "Nothing to render.", cards };
      },
    },

    set_preference: {
      def: { name: "set_preference", description: "Change a preference: name, timezone, workday_start (HH:MM), workday_end, focus_block_min, break_min, autonomy (ask|act), theme, model.", input_schema: { type: "object", properties: { key: { type: "string" }, value: { type: "string" } }, required: ["key", "value"] } },
      run: (input) => {
        const key = (str(input.key) ?? "").toLowerCase().replace(/\s+/g, "_");
        const value = str(input.value) ?? "";
        const toMin = (v: string) => { const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(v.trim()); if (!m) return undefined; let h = Number(m[1]); if (m[3]?.toLowerCase() === "pm" && h < 12) h += 12; if (m[3]?.toLowerCase() === "am" && h === 12) h = 0; return h * 60 + Number(m[2] ?? 0); };
        let patch: Record<string, unknown> | undefined;
        if (key === "name") patch = { name: value.replace(/^\w/, (c) => c.toUpperCase()) };
        else if (key === "timezone" || key === "time_zone") { if (!isValidTimeZone(value)) return { text: `"${value}" isn't a timezone I recognize (try 'America/New_York').`, ok: false }; patch = { timezone: value }; }
        else if (key.includes("start")) { const m = toMin(value); if (m === undefined) return { text: "Give me a time like 09:00.", ok: false }; patch = { workdayStartMin: m }; }
        else if (key.includes("end")) { const m = toMin(value); if (m === undefined) return { text: "Give me a time like 18:00.", ok: false }; patch = { workdayEndMin: m }; }
        else if (key === "focus_block_min") patch = { focusBlockMin: Number(value) || 90 };
        else if (key === "break_min") patch = { breakMin: Number(value) || 10 };
        else if (key === "autonomy") patch = { autonomy: value === "ask" ? "ask" : "act" };
        else if (key === "theme") patch = { theme: ["light", "dark", "system"].includes(value) ? value : "system" };
        else if (key === "model") patch = { model: value };
        else if (key === "voice") patch = { voice: /^(on|true|yes|1)$/i.test(value) };
        if (!patch) return { text: `I don't have a preference called "${key}".`, ok: false };
        repo.setPrefs(patch);
        return { text: `Set ${key} to ${value}.`, mutated: ["prefs"] };
      },
    },

    create_goal: {
      def: {
        name: "create_goal",
        description: "Create a goal the planner should align to. Tasks can be linked to it; the council and the brief report alignment.",
        input_schema: { type: "object", properties: { title: { type: "string" }, why: { type: "string" }, horizon: { type: "string", enum: ["week", "month", "quarter", "year"] }, target_date: { type: "string" }, pinned: { type: "boolean" } }, required: ["title"] },
      },
      run: (input, now) => {
        const title = str(input.title);
        if (!title) return { text: "A goal needs a title.", ok: false };
        const existing = repo.findGoal(title);
        if (existing) return { text: `Already tracking “${existing.title}”.`, cards: [{ type: "goals", goals: [existing] }] };
        const g = repo.createGoal({ title, why: str(input.why), horizon: (str(input.horizon) as Goal["horizon"]) ?? "month", targetDate: resolveWhen(input.target_date, now)?.toISOString(), pinned: !!input.pinned });
        return { text: `Goal set: ${g.title} (${g.horizon}${g.targetDate ? `, by ${formatDate(new Date(g.targetDate), tz())}` : ""}).`, cards: [{ type: "goals", goals: [g] }], mutated: ["goal"] };
      },
    },

    update_goal: {
      def: { name: "update_goal", description: "Update a goal's progress (0..1), status, title, or target date; or link a task to it.", input_schema: { type: "object", properties: { id: { type: "string" }, query: { type: "string" }, progress: { type: "number" }, status: { type: "string", enum: ["active", "done", "paused"] }, title: { type: "string" }, target_date: { type: "string" }, link_task: { type: "string", description: "task id or fuzzy title to link" } } } },
      run: (input, now) => {
        const g = (str(input.id) && repo.getGoal(str(input.id)!)) || (str(input.query) ? repo.findGoal(str(input.query)!) : undefined);
        if (!g) return { text: `No goal matches “${str(input.query) ?? ""}”.`, ok: false };
        const mutated: MutatedEntity[] = ["goal"];
        if (str(input.link_task)) {
          const t = repo.getTask(str(input.link_task)!) ?? repo.findTask(str(input.link_task)!);
          if (t) { repo.updateTask(t.id, { goalId: g.id }); mutated.push("task"); }
        }
        const patch: Partial<Goal> = {};
        if (num(input.progress) !== undefined) patch.progress = Math.max(0, Math.min(1, num(input.progress)!));
        if (str(input.status)) patch.status = str(input.status) as Goal["status"];
        if (str(input.title)) patch.title = str(input.title);
        if (input.target_date !== undefined) patch.targetDate = resolveWhen(input.target_date, now)?.toISOString();
        const next = repo.updateGoal(g.id, patch)!;
        return { text: `Goal updated: ${next.title} · ${Math.round(next.progress * 100)}%${next.status !== "active" ? ` · ${next.status}` : ""}.`, cards: [{ type: "goals", goals: [next] }], mutated };
      },
    },

    list_goals: {
      def: { name: "list_goals", description: "List active goals with how much focus each is getting.", input_schema: { type: "object", properties: {} } },
      run: (_input, now) => {
        const goals = repo.listGoals();
        if (!goals.length) return { text: "No goals yet. Say “goal: ship v1 by October” to set one.", cards: [] };
        const al = svc.goalAlignment(now);
        return { text: `Goals:\n${goals.map((g) => `- ${g.title} (${g.horizon}, ${Math.round(g.progress * 100)}%) — ${al.find((a) => a.goalId === g.id)?.focusMin ?? 0} min of focus this week [${g.id}]`).join("\n")}`, cards: [{ type: "goals", goals, alignment: al }] };
      },
    },

    assess_risk: {
      def: { name: "assess_risk", description: "Simulate the coming days (Monte Carlo over calibrated estimates and calendar) and report which deadlines are at risk, with ranked interventions.", input_schema: { type: "object", properties: { horizon_days: { type: "integer" } } } },
      run: (input, now) => {
        const report = svc.futures(now, num(input.horizon_days) ?? 7);
        const danger = report.risks.filter((r) => r.level !== "safe");
        const text = danger.length
          ? `${danger.length} deadline${danger.length === 1 ? "" : "s"} at risk over ${report.horizonDays} days (capacity ${Math.round(report.capacity.ratio * 100)}% committed):\n${danger.map((r) => `- ${Math.round(r.pMiss * 100)}% miss · ${r.title} (due ${r.due.slice(0, 10)}, expected ${r.expectedDay})`).join("\n")}${report.interventions.length ? `\nBest moves:\n${report.interventions.slice(0, 3).map((i) => `- ${i.title} (−${Math.round(i.riskDelta * 100)}% of risk)`).join("\n")}` : ""}`
          : `No deadline is at meaningful risk over the next ${report.horizonDays} days. Capacity ${Math.round(report.capacity.ratio * 100)}% committed.`;
        return { text, cards: [{ type: "risk", report }] };
      },
    },

    convene_council: {
      def: { name: "convene_council", description: "Run the council: strategist, realist, guardian, connector and editor each critique the current week; returns findings with evidence, a synthesis and one decision. Use before big planning advice.", input_schema: { type: "object", properties: { question: { type: "string" } } } },
      run: (input, now) => {
        const verdict = svc.localCouncil(now, str(input.question));
        return { text: `Council (${verdict.findings.length} findings): ${verdict.synthesis}\nDecision: ${verdict.decision}\n${verdict.findings.map((f) => `- [${f.severity}] ${f.perspective}: ${f.claim}`).join("\n")}`, cards: [{ type: "council", verdict }] };
      },
    },

    show_mirror: {
      def: { name: "show_mirror", description: "What Kairos has learned about the person: estimate bias per energy, real peak hours, plan adherence, slip rates, and any proposed energy curve.", input_schema: { type: "object", properties: {} } },
      run: (_input, now) => {
        const cal = svc.calibration(now);
        const lines = describeCalibrationLines(cal);
        return { text: lines.length ? lines.join(" ") : `Not enough completed work yet to learn from (${cal.sampleSize} outcomes). Keep going; the mirror sharpens around 10.`, cards: [{ type: "calibration", calibration: cal }] };
      },
    },

    undo_last: {
      def: { name: "undo_last", description: "Undo the most recent autonomous action from the ledger (or a specific ledger id).", input_schema: { type: "object", properties: { id: { type: "string" } } } },
      run: (input) => {
        const e = svc.undo(str(input.id));
        if (!e) return { text: "Nothing to undo.", ok: false };
        return { text: `Undone: ${e.summary}`, cards: [{ type: "ledger", entries: [e] }], mutated: ["ledger", "task", "plan", "prefs"] };
      },
    },

    parse_time: {
      def: { name: "parse_time", description: "Resolve natural-language time in the person's timezone. Use when you need the exact instant before creating something.", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
      run: (input, now) => {
        const c = parseChrono(str(input.text) ?? "", { now, tz: tz() });
        return { text: JSON.stringify({ start: c.start?.toISOString(), end: c.end?.toISOString(), allDay: c.allDay, isDeadline: c.isDeadline, durationMin: c.durationMin, recurrence: c.recurrence, remainder: c.remainder }) };
      },
    },

    get_context: {
      def: { name: "get_context", description: "Fresh snapshot of the person's world: time, workday, open tasks, today's events, drifting people, profile.", input_schema: { type: "object", properties: {} } },
      run: (_input, now) => ({ text: svc.contextSnapshot(now) }),
    },
  };

  return tools;
}

import { describeCalibration as describeCalibrationLines } from "../../core/index.js";

export function guessEnergy(title: string): Energy {
  if (/\b(write|writing|draft|design|code|coding|research|think|study|outline|essay|deck|proposal|strategy|architecture|analy[sz]e|deep)\b/i.test(title)) return "deep";
  if (/\b(call|text|message|email .* to|meet|coffee|lunch|dinner|chat|catch up|reach out|talk|ping|thank|reply to|follow up with)\b/i.test(title)) return "social";
  if (/\b(pay|invoice|renew|book|order|submit|file|form|tax|expense|schedule|register|cancel|return|print|sign|passport|insurance|bank|groceries|laundry|clean|errand|inbox|admin)\b/i.test(title)) return "admin";
  return "light";
}

export type ToolRegistry = ReturnType<typeof buildTools>;
