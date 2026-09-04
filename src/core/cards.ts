import type { Card } from "./types.js";
import { briefToText } from "./brief.js";
import { fmtHM, formatMoney } from "./worklog.js";

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
    case "risk":
      return `Futures (${card.report.horizonDays}d, ${card.report.runs} runs, capacity ${Math.round(card.report.capacity.ratio * 100)}%):\n${card.report.risks.map((r) => `- ${Math.round(r.pMiss * 100)}% miss · ${r.title} (due ${r.due.slice(0, 10)}, expected ${r.expectedDay})`).join("\n")}${card.report.interventions.length ? `\nInterventions:\n${card.report.interventions.map((i) => `- ${i.title} (−${Math.round(i.riskDelta * 100)}% of risk)`).join("\n")}` : ""}`;
    case "council":
      return `Council on “${card.verdict.question}”:\n${card.verdict.findings.map((f) => `- [${f.severity}] ${f.perspective}: ${f.claim} (${f.evidence})${f.suggestion ? ` → ${f.suggestion}` : ""}`).join("\n")}\nSynthesis: ${card.verdict.synthesis}\nDecision: ${card.verdict.decision}`;
    case "calibration": {
      const c = card.calibration;
      return `Calibration from ${c.sampleSize} outcomes: ${Object.entries(c.estimateBias).map(([k, v]) => `${k} ×${v.factor} (n=${v.n})`).join(", ")}; plan adherence ${Math.round(c.planAdherence.rate * 100)}%; slip ${Math.round(c.slipRate.overall * 100)}%.`;
    }
    case "goals":
      return `Goals:\n${card.goals.map((g) => `- ${g.title} (${g.horizon}, ${Math.round(g.progress * 100)}%${g.targetDate ? `, by ${g.targetDate.slice(0, 10)}` : ""})`).join("\n")}`;
    case "ledger":
      return `Ledger:\n${card.entries.map((e) => `- ${e.createdAt.slice(0, 16)} ${e.summary}${e.undoneAt ? " (undone)" : ""}`).join("\n")}`;
    case "payroll": {
      const p = card.payroll;
      return `Payroll for ${p.name}, ${p.from} to ${p.to} at ${formatMoney(p.rate, p.currency)}/h: ${fmtHM(p.totalMinutes)} = ${formatMoney(p.amount, p.currency)}\n${p.weeks.map((w) => `- week of ${w.start}: ${fmtHM(w.minutes)} = ${formatMoney(w.amount, p.currency)}`).join("\n")}`;
    }
  }
}

export function isCard(x: unknown): x is Card {
  return !!x && typeof x === "object" && typeof (x as { type?: unknown }).type === "string";
}
