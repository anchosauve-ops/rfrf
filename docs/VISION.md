# Why Kairos exists

*Kairos* (καιρός) is the Greek word for the opportune moment: not clock time, but the right time. That's the whole product in one word.

## The prediction

Ask what most people will use every day in five years and the honest answer is not a new device or a new network. It's a change in who does the coordinating.

Today a person coordinates their own life across a calendar app, a task app, a notes app, a messaging app and, lately, a chat window. The person is the integration layer. They carry the state in their head, they translate between tools, they remember to remember.

The agent-first shift moves that integration layer out of the head and into software that:

1. holds the state (time, commitments, people, preferences, goals),
2. acts on it on a schedule and on triggers, not only when asked,
3. explains itself, so trust can build, and
4. speaks the person's language in both directions.

That layer is what people will open first each morning. Not because it's magical, but because it's where their day already is.

## What Kairos does differently

**Agent-first, not chat-first.** Chat is one input among several. The primary surface is the day itself: what's now, what's next, what slipped, who's drifting. The agent manifests as cards and nudges inside that surface, not as a separate window you have to go visit.

**Explainable planning.** Most "AI planners" are a black box over an LLM call. Kairos plans with a deterministic algorithm that scores urgency, importance, age and energy fit, and every block carries its reason. The model, when present, reasons *about* the plan; it doesn't hallucinate one.

**Memory you can audit.** The single biggest reason people don't trust personal AI is that they can't see what it thinks it knows. Kairos memories have provenance (stated vs inferred), confidence, evidence, and decay. The Memory page is the product's conscience.

**Rituals and watchers.** A personal agent that only answers is a search box. Kairos runs a morning brief, an evening review and a weekly retro on a schedule, and watches for the failure modes of a real week: things overdue, people neglected, days overloaded, deadlines unplanned.

**Works without the model.** The deterministic Local Mind isn't a degraded mode; it's the substrate. It means the product works offline, on a plane, when the API is down, when you don't want to pay. It also means the model's job is judgment, not parsing, which makes it cheaper and more reliable.

**Local-first.** One SQLite file. Your life should not live in someone else's database by default.

## What it is not, yet

- Not multi-user. Not synced across devices. (The domain core is I/O free so sync is an adapter, not a rewrite.)
- Not connected to external calendars or email. (Same story: adapters over `Repo`.)
- Not a replacement for a human's judgment about their own life. It proposes; it explains; it acts on the small, reversible stuff. The big calls stay with the person.

## Design principles

- **Every action explains itself.** Blocks have reasons, memories have evidence, nudges have origins.
- **Do less when it matters.** If someone is overwhelmed, one next step beats a beautiful plan.
- **Slack is a feature.** The planner leaves 15% open on purpose.
- **Text is the garnish.** Cards carry the content.
- **Trust is built in the Memory page.** If it can't be inspected, it doesn't get stored.
