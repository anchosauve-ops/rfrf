<p align="center">
  <img src="public/icons/icon-192.png" width="72" alt="Kairos" />
</p>

<h1 align="center">Kairos</h1>

<p align="center"><em>A proactive personal agent that runs your day.<br/>Your time, your memory, your people — planned, remembered, and nudged by something that never forgets.</em></p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#what-it-does">What it does</a> ·
  <a href="#two-brains">Two brains</a> ·
  <a href="docs/VISION.md">Why this exists</a> ·
  <a href="docs/ARCHITECTURE.md">Architecture</a>
</p>

![Kairos — Now](docs/screenshots/now.png)

---

## The bet

In five years the app most people open first every morning won't be a chat window or a to-do list. It'll be an **agent-first layer over your time**: one surface that knows your calendar, your commitments, your energy, and the people who matter, and that acts on them, on a schedule, without being asked.

Kairos is my version of that layer, built today. It is local-first, works with no model at all, and gets sharper the moment you give it one.

## What it does

**Plans your day, and tells you why.** The planner takes open tasks, fixed events and your personal energy curve and lays out a time-blocked day: deep work in your peak, admin in the trough, buffers around meetings, breaks after long focus, a slack reserve so the day isn't scheduled to 100%. Every block carries a reason ("due today · important · deep work in your focus window"). Click one and it explains itself.

**Understands you in plain language.** `call mom tomorrow at 5` becomes a pinned task. `submit the report by friday eod` becomes a deadline. `meeting with Sam and Priya next tue 3pm for 45 min` becomes an event with two people linked. `every weekday 8am journal` becomes a recurring task. This works offline; the parser is deterministic and covered by tests.

**Remembers with receipts.** Every memory has a kind (goal, preference, insight, relationship, fact, episode), a source (stated or inferred), a confidence, and the evidence it came from. Memories fade at different rates depending on kind. You can read all of it, pin it, correct it, or delete it. Nothing is hidden.

**Keeps your relationships alive.** People have a cadence. When someone drifts past it, Kairos notices and offers a one-click way back.

**Works while you're not looking.** Rituals run on a schedule: a morning brief (which also plans the day), an evening review, a weekly retro. Watchers fire between them: overdue tasks, drifting people, an overloaded day, an important deadline that isn't on the plan yet, a workday that started with no plan. Both land as nudges on the Now page with actions attached.

**Speaks in cards, not walls.** The agent returns structured UI: task lists, plans, briefs, decisions with options, checklists, metrics. Text is the garnish.

**Voice in, voice out.** Push-to-talk in the command bar and optional spoken replies, using the browser's own speech APIs.

**Yours.** One SQLite file. Export everything as JSON, import it anywhere. Installable as a PWA. MIT.

| Day view | Memory | Agent |
|---|---|---|
| ![Day](docs/screenshots/day.png) | ![Memory](docs/screenshots/memory.png) | ![Agent](docs/screenshots/agent.png) |

## Two brains

Kairos has one set of capabilities and two brains that drive them.

**Local Mind** runs when there is no API key. It's an intent parser, a time parser, a planner and a memory engine. It doesn't chat, but it does the job: tasks, events, plans, briefs, memory, people, focus. Zero network.

**Claude** runs when you add an Anthropic API key (Settings, or `ANTHROPIC_API_KEY`). It uses the same tools through streaming tool use, with the person's context and memory profile in the system prompt, and adds judgment: it notices overload, splits ambiguous requests, writes memories with evidence as you talk, and holds a real conversation. If the API is unreachable, it falls back to Local Mind for that turn and says so.

Both brains share one tool registry, so anything one can do the other can do; the model just does it with taste.

## Quick start

Requires Node 22.13+ (built-in SQLite; no native modules) and pnpm.

```bash
pnpm install
pnpm dev          # server on :8787, web on :5173
```

Open http://localhost:5173. Onboarding asks for a name and timezone, offers a demo day, and takes an optional API key.

Production build:

```bash
pnpm build
pnpm start        # serves API + web on :8787
```

Environment (all optional, see `.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | unset | Turns on the Claude brain |
| `KAIROS_MODEL` | `claude-opus-5` | Model id (also settable in the UI) |
| `KAIROS_DB` | `./data/kairos.db` | Where your life lives |
| `PORT` | `8787` | Server port |

## Talk to it

```
plan my day                         what's on tomorrow
remind me to renew my passport #admin !2 (40m) by the 15th
lunch with Dana friday 12-1 at Blue Bottle
block 9-11am tomorrow for deep work
done with the investor update       move dentist to next week
remember I do my best writing before noon
what do you know about my goals     forget that
met Priya, colleague from design, every 2 weeks
talked to Sam                       who should I reach out to
focus for 50 on the essay           evening review
```

Keyboard: `⌘K` or `/` focuses the command bar, `1–7` switch views, `Esc` collapses the thread.

## Scripts

```bash
pnpm dev        # both servers with hot reload
pnpm test       # 92 tests across parser, planner, memory, rrule, brief, server, scheduler
pnpm typecheck  # web + server
pnpm build      # web bundle + server transpile
pnpm check      # all of the above
```

## API

Everything the UI does goes through `/api`. Highlights:

- `POST /api/agent` — SSE stream of agent events (`start`, `text`, `thinking`, `tool_start`, `tool_end`, `card`, `mutation`, `done`)
- `POST /api/agent/sync` — same, buffered, for scripts and voice assistants
- `GET /api/plan?date=YYYY-MM-DD` · `POST /api/plan` — read or rebuild a day plan
- `GET /api/brief?kind=morning|evening|weekly`
- `GET /api/stream` — live channel: nudges, rituals, mutations
- CRUD on `/api/tasks`, `/api/events`, `/api/memories`, `/api/people`, `/api/rituals`, `/api/watchers`, `/api/nudges`
- `GET /api/export` · `POST /api/import`

## Project shape

```
src/core     pure domain: types, chrono, intent, planner, memory, brief, rrule, cards
src/server   Hono + node:sqlite; repo, services, tools, two brains, scheduler, SSE
src/web      React + Vite PWA; design system, command bar, seven views
tests        vitest
docs         vision, architecture, screenshots
```

## Status

v0.1. Single-user, local-first, no accounts. Calendar sync (CalDAV/Google), email triage, a native mobile shell and multi-device sync are the obvious next layers; the domain core is built so they slot in as adapters rather than rewrites.

MIT © 2026 Kairos contributors
