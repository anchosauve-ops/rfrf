# Kairos — notes for agents and contributors

Kairos is a local-first, symbiotic personal agent: it runs a person's day and learns from what actually happens. Read `docs/VISION.md` for why and `docs/ARCHITECTURE.md` for how.

## Layout and rules

- `src/core` is pure: no Node, no DOM, no network, no `Date.now()`, no random ids. Every function takes `now` and `tz`; the planner derives block ids from the date and a counter. Ids for stored entities come from `src/server/ids.ts`. If you need I/O, you are in the wrong layer.
- `src/server` is the only place that talks to SQLite (`repo.ts`), the Anthropic API (`agent/`), the clock and the filesystem.
- `src/web` talks to the server over `/api` only. Anything in the UI that wants the agent calls `runCommand(text)`.
- One tool registry (`src/server/agent/tools.ts`) serves both brains. If you add a capability, add it there first; then an intent in `core/intent.ts` and a case in `agent/local.ts` if the Local Mind should reach it without a model.
- Every write that comes over HTTP goes through `src/server/validate.ts`.
- Autonomous actions go through `Services.intervene` so they land in the ledger with an undo payload. Guardian may defer; it may not scope work down or delete. Undo payloads use `null` (never `undefined`) for fields that must be cleared, because they round-trip through JSON.
- Tool executors coerce model-supplied enums and ranges (`energyOf`, `priorityOf`, `estimateOf` in `tools.ts`); the API does not enforce tool schemas without `strict`.
- Charts use the validated palette in `styles/app.css`. Status colors always ship with a text label.

## Commands

```bash
pnpm dev          # server :8787 + web :5173
pnpm check        # lint, typecheck, test, build
pnpm e2e          # browser smoke test against dist (needs Chromium; PW_CHROMIUM to point at one)
```

## Conventions

- Tests in `tests/`, vitest, deterministic (fixed `now`, fixed `tz`, seeded RNG).
- No date libraries; use `core/tz.ts`.
- Reasons everywhere: plan blocks, nudges, memories, ledger entries all say why.
- Prefer cards over prose in agent output.

## Things that look like bugs but aren't

- `node:sqlite` prints an experimental warning; `pnpm start` suppresses it.
- The planner leaves ~15% of free time open on purpose (slack).
- Someday tasks (priority 4) are planned only when there is room, and never ahead of dated work.
- Fable/Mythos models reject an explicit `thinking` parameter; `agent/claude.ts` omits it for them.
