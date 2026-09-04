# Changelog

## 1.0.0 — 2026-09-03

The end version of the first arc: a symbiotic personal intelligence that runs your day and learns from it.

### Run your day
- Natural-language time and intent parsing, offline and zone-aware (deadlines vs pinned times, ranges, durations, recurrence, month names).
- Explainable day planner: urgency, priority, age, quick wins, energy fit, meeting buffers, breaks, task splitting, slack reserve. Every block carries its reason.
- Tasks, events, people with cadence, memory with provenance and decay, rituals (morning brief, evening review, weekly retro) and watchers that produce actionable nudges.
- Two brains over one tool registry: Local Mind (no key, no network) and Claude (streaming tool use, graceful fallback).

### Symbiosis
- Learning: outcomes recorded on every completion; per-energy estimate bias with shrinkage, real peak hours, plan adherence, slip rates; a proposed energy curve once evidence is strong. Planner and simulator consume it.
- Futures: seeded Monte Carlo over the coming days; probability of missing each deadline, expected load per day, interventions ranked by share of risk removed.
- Council: strategist, realist, guardian, connector, editor. Deterministic critics offline; five parallel Claude perspectives plus a chair with a key.
- Guardian and Ledger: autonomous deferrals when a real deadline is at risk, always logged, always undoable. Never scopes work down on its own.
- Goals with alignment and pace; nightly reflection that writes learned insights into memory.
- Mirror: the learned model in plain words, with the dials that decide what Kairos may do with it.

### Team and payroll
- People can carry an hourly rate, currency and expected weekly hours.
- Work logs per person per day; Sunday–Saturday payroll with cents; payroll cards; a Team line in the brief and retro; a light-week watcher.
- OnlineJobs.ph Timeproof connection: bookmarklet (token-gated import endpoint, the one route a foreign origin may call), paste import that recognizes week and month totals in the copied calendar, and plain commands.

### Final review fixes
- Guardian deferrals are now visible to the simulator (snoozed tasks don't compete or get re-suggested), and their undo payloads survive JSON so Undo actually clears the snooze.
- Planning a future day no longer overwrites today's placements.
- Tool inputs are coerced to valid enums and ranges; calibration tolerates malformed history; imports are sanitized record by record.
- Completing a recurring task attributes focus minutes to the original task and clears its placement.
- An undecryptable stored API key is reported in Settings instead of being sent to the API.
- Partial ritual updates keep their frequency; "move X to eod" honors the configured workday end; the unplanned-day watcher uses minute precision.
- Planner ids are deterministic; `src/core` no longer touches the clock. Demo data uses real zone math.
- Mocked-client tests for the Claude loop, the council and the fallback path.

### Production hardening
- Validation and bounds on every HTTP write; 400s with messages; 413 on oversized bodies.
- API key encrypted at rest; legacy plaintext upgraded on read.
- Daily backups with retention; on-demand backup endpoint; health reports uptime and last backup.
- Request logging; crash-contained scheduler ticks; graceful shutdown.
- ESLint, a Chromium end-to-end smoke test and a Docker health probe in CI; migration test from the v1 schema.
- CLAUDE.md, SECURITY.md, CONTRIBUTING.md.

### Product
- React PWA with a validated light/dark design system, streaming command bar with cards and voice, nine views, onboarding, focus mode, export/import.
- Hono + `node:sqlite` server, SSE agent stream and live channel, CORS restricted to local origins, binds to 127.0.0.1 by default.
- Dockerfile, GitHub Actions CI, 152 tests.
