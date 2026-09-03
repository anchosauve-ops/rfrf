import type { Card } from "./types.js";
import { briefToText } from "./brief.js";

/** Plain text fallback for any card — used for voice, transcripts and the model's own reading. */
export function cardToText(card: Card): string {
  switch (card.type) {
    case "text":
      return card.markdown;
    case "tasks":
      return `${card.title ?? "Tasks"}:\n${card.tasks.map((t) => `- [${t.status === "done" ? "x" : " "}] ${t.title}${t.due ? ` (due ${t.due.slice(0, 10)})` : ""}`).join("\n")}`;
    case "events":
      return `${card.title ?? "Events"}:\n${card.events.map((e) => `- ${e.start.slice(11, 16)}–${e.end.slice(11, 16)} ${e.title}`).join("\n")}`;
    case "plan":
      return `Plan for ${card.plan.date} (${card.plan.stats.loadPct}% load):\n${card.plan.blocks.filter((b) => b.kind !== "buffer").map((b) => `- ${b.start.slice(11, 16)}–${b.end.slice(11, 16)} ${b.title}${b.reason ? ` — ${b.reason}` : ""}`).join("\n")}`;
    case "brief":
      return briefToText(card.brief);
    case "memories":
      return `${card.title ?? "Memories"}:\n${card.memories.map((m) => `- (${m.kind}) ${m.text}`).join("\n")}`;
    case "people":
      return `${card.title ?? "People"}:\n${card.people.map((p) => `- ${p.name}${p.relation ? ` (${p.relation})` : ""}`).join("\n")}`;
    case "checklist":
      return `${card.title}:\n${card.items.map((i) => `- [${i.done ? "x" : " "}] ${i.text}`).join("\n")}`;
    case "decision":
      return `${card.question}\n${card.options.map((o, i) => `${i + 1}. ${o.label} — ${o.rationale}`).join("\n")}`;
    case "metrics":
      return `${card.title ?? "Metrics"}: ${card.items.map((i) => `${i.label} ${i.value}`).join(" · ")}`;
    case "confirm":
      return `Confirm: ${card.summary}`;
    case "focus":
      return `Focus: ${card.title} for ${card.minutes} min`;
  }
}

export function isCard(x: unknown): x is Card {
  return !!x && typeof x === "object" && typeof (x as { type?: unknown }).type === "string";
}
