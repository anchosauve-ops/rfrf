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

### Product
- React PWA with a validated light/dark design system, streaming command bar with cards and voice, nine views, onboarding, focus mode, export/import.
- Hono + `node:sqlite` server, SSE agent stream and live channel, CORS restricted to local origins, binds to 127.0.0.1 by default.
- Dockerfile, GitHub Actions CI, 113 tests.
