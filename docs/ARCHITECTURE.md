# Architecture

Kairos is three layers with strict dependencies: **web → server → core**, and never the other way.

```
┌───────────────────────────────────────────────────────────────┐
│ web (React + Vite PWA)                                         │
│  Composer (SSE stream, voice) · Cards · Now/Day/Tasks/Memory/  │
│  People/Rituals/Settings · live channel (EventSource)          │
└───────────────▲───────────────────────────────▲───────────────┘
                │ REST + SSE                     │ /api/stream
┌───────────────┴───────────────────────────────┴───────────────┐
│ server (Hono + node:sqlite)                                    │
│  app.ts routes ─► Services ─► Repo ─► SQLite                   │
│  Agent { Claude brain | Local Mind } ─► Tool registry ─► Services│
│  Scheduler (rituals, watchers) ─► Nudges ─► Bus ─► SSE         │
└───────────────────────────────▲───────────────────────────────┘
                                │ pure functions, no I/O
┌───────────────────────────────┴───────────────────────────────┐
│ core                                                            │
│  types · tz · chrono · intent · rrule · planner · memory ·      │
│  brief · cards                                                  │
└───────────────────────────────────────────────────────────────┘
```

## core (`src/core`)

Pure TypeScript. No Node APIs, no DOM, no network. Everything is a function of its inputs plus an explicit `now` and `tz`, which is what makes 92 tests fast and deterministic.

- **`tz.ts`** — Intl-based zone math (`toZoned`, `fromZoned`, `startOfDay`, `addDays`, `setTime`). DST-safe by two-pass offset resolution. Avoids a date library entirely.
- **`chrono.ts`** — natural-language time. Sequential regex passes each consume a span (recurrence → relative → duration → explicit dates → day words → weekdays → clock times/ranges) and return the remainder as a clean title. Knows deadlines ("by", "before", "eod") from pins ("at").
- **`intent.ts`** — offline command understanding. Ordered pattern groups (meta → plan → schedule → lists → people → focus → preferences → memory → completion/reschedule → events → tasks → chat) with a confidence score and a trace.
- **`rrule.ts`** — minimal recurrence (`daily|weekly|monthly|yearly`, interval, byWeekday, byMonthDay, time, until) with `nextOccurrence` and `describeRule`.
- **`planner.ts`** — the day planner. Free windows = workday − events (with buffers) − pinned tasks. Candidates scored `urgency + priority + age (+ quick-win)`; per-slot `energy fit` added at placement. Greedy in time order; splits tasks ≥ 60 min when needed; inserts breaks after `focusBlockMin`; caps placement at 85% of free time (slack). Emits `PlanBlock[]` with reasons, an `unscheduled` list with reasons, and stats.
- **`memory.ts`** — tokenizer with light two-pass stemming; scoring = lexical × importance × recency(half-life by kind) × confidence + pin/usage boosts; near-duplicate detection (Jaccard); candidate extraction from free text; profile summary for the system prompt.
- **`brief.ts`** — morning / evening / weekly composition from data. Deterministic text and cards; a model may add narrative on top.
- **`cards.ts`** — generative-UI card union → plain text (for voice, transcripts and the model).

## server (`src/server`)

- **`db.ts`** — `node:sqlite` (built into Node ≥ 22.13; no native module build). Versioned migrations in `meta`.
- **`repo.ts`** — the only module that speaks SQL. Domain objects in, domain objects out. Fuzzy `findTask` / `findPerson` / `findEvent` so "done with the report" resolves.
- **`services.ts`** — operations shared by both brains, the scheduler and the routes: `plan`, `brief`, `stalePeople`, `overdueTasks`, `contextSnapshot`.
- **`agent/tools.ts`** — one tool registry: Anthropic `Tool` definitions plus executors returning `{ text, cards, mutated }`. Natural-language times pass straight through to `chrono` in the person's zone. Known people are auto-linked when named in a title.
- **`agent/local.ts`** — Local Mind: `parseIntent` → tool → short reply. Splits compound requests when the tail is unmistakably its own command. Mines free text for memory candidates.
- **`agent/claude.ts`** — streaming manual tool-use loop on `client.messages.stream()` with `finalMessage()`. Adaptive thinking (summarized) and `effort: medium` on models that support it; omitted on Fable/Mythos (always thinking) and older models. Handles `tool_use`, `pause_turn`, `refusal`. System prompt: stable character block (cache-controlled) + fresh context snapshot.
- **`agent/index.ts`** — picks the brain by key presence; on typed API errors falls back to Local Mind for the turn and reports why.
- **`scheduler.ts`** — 60s tick. Rituals fire when `nextOccurrence(rule, lastRunAt) <= now`; the morning ritual also builds the day plan. Watchers evaluate with per-watcher cooldowns. Both write `Nudge`s and publish on the `Bus`.
- **`app.ts`** — Hono routes; `POST /api/agent` streams `AgentEvent`s over SSE; `GET /api/stream` fans the bus to every open tab; serves `dist/web` in production with SPA fallback. `seedDemo` builds a believable first day.

## web (`src/web`)

- **Design system** (`styles/app.css`): warm paper / ink, one amber accent, four energy hues; light and dark via `data-theme`; serif display face for the human moments, mono for time. Mobile: rail becomes bottom tabs; composer floats above.
- **State**: a tiny external store (`useSyncExternalStore`) plus `useResource(path, entities)` which re-fetches when a live `mutation` for one of its entities arrives, from this tab (`emitLocal`) or the server (`EventSource`).
- **Composer**: POST + `ReadableStream` SSE parser; renders text deltas, tool badges, thinking summaries and cards as they arrive; push-to-talk via Web Speech; optional spoken replies. Anything in the UI can `runCommand(text)` to talk to the agent, which is how nudge actions, decision cards and buttons work.
- **Views**: Now (greeting, nudges, now/next with reasons, plan, stats), Day (hour grid, energy-colored blocks, click for reason), Tasks (grouped, inline edit, natural-language capture with live time preview), Memory (grouped by kind, provenance, confidence, evidence, pin/forget/correct), People (cadence rings), Rituals (schedules + watchers), Settings (brain, you, energy curve, data).
- **PWA**: manifest, SVG + PNG icons, shell-caching service worker (registered on HTTPS only).

## Data flow for one turn

```
"move dentist to next week"
  → POST /api/agent (SSE)
  → Agent.run: addTurn(user) → brain
      Local: parseIntent → reschedule_task{query:"dentist", when, allDay}
             → tools.update_task (fails: it's an event) → tools.update_event ✓
      Claude: messages.stream(system+tools+history) → tool_use update_event → result → text
  → events: start, tool_start, card(events), mutation(event), mutation(plan), text, done
  → client: renders card, emits local mutation → Day/Now views re-fetch
  → Repo.addTurn(assistant, cards)
```

## Testing

`vitest`, 92 tests: chrono (zones, DST, ranges, recurrence), intent (every intent family), planner (no overlaps, buffers, pins, splits, energy placement, weekend protection), memory (ranking, decay, dedupe, extraction), rrule, brief, and server (REST, SSE, agent turns, scheduler cooldowns, export/import idempotence, key → mode).

## Extending

- **New tool**: add an entry to `buildTools`; both brains get it. If Local Mind should reach it, add an intent in `core/intent.ts` and a case in `local.ts`.
- **New card**: extend the `Card` union, `cardToText`, and `CardView`.
- **New watcher**: add a kind to `WatcherKind`, a case in `Scheduler.evaluateWatcher`, and a default in `Repo.ensureDefaults`.
- **External calendar / email**: implement an adapter that writes through `Repo` (events, tasks, people) on its own schedule; nothing above `Repo` needs to know.
