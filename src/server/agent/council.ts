/**
 * Claude council — five perspectives in parallel, one synthesis.
 * Each perspective gets the same evidence pack and its own charter, and must
 * return structured findings. The synthesis call reads all findings and
 * produces the verdict. Falls back to the local council on any failure.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Services } from "../services.js";
import { CHARTERS, cardToText, type CouncilFinding, type CouncilVerdict, type Perspective } from "../../core/index.js";

const PERSPECTIVES: Perspective[] = ["strategist", "realist", "guardian", "connector", "editor"];

function evidencePack(svc: Services, now: Date): string {
  const input = svc.councilInput(now);
  const parts = [
    svc.contextSnapshot(now),
    input.plan ? cardToText({ type: "plan", plan: input.plan }) : "No plan for today.",
    input.risk ? cardToText({ type: "risk", report: input.risk }) : "",
    input.calibration ? cardToText({ type: "calibration", calibration: input.calibration }) : "",
    input.goals.length ? cardToText({ type: "goals", goals: input.goals }) : "No goals set.",
    `Open tasks (${input.tasks.filter((t) => t.status === "open").length}):\n` + input.tasks.filter((t) => t.status === "open").slice(0, 40).map((t) => `- ${t.title} [p${t.priority}, ${t.energy}, ${t.estimateMin}m${t.due ? `, due ${t.due.slice(0, 10)}` : ""}${t.goalId ? ", goal-linked" : ""}]`).join("\n"),
    `Week's events: ` + input.events.map((e) => `${e.start.slice(0, 16)} ${e.title}`).join("; "),
    `People: ` + input.people.map((p) => `${p.name}${p.relation ? ` (${p.relation})` : ""}${p.cadenceDays ? `, every ${p.cadenceDays}d` : ""}${p.lastContactAt ? `, last ${p.lastContactAt.slice(0, 10)}` : ""}`).join("; "),
  ];
  return parts.filter(Boolean).join("\n\n");
}

export async function claudeCouncil(client: Anthropic, model: string, svc: Services, now: Date, question?: string): Promise<CouncilVerdict> {
  const pack = evidencePack(svc, now);
  const q = question ?? "How does this week look, and what should change?";
  const findingsSchema = {
    type: "object" as const,
    properties: {
      findings: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            severity: { type: "string" as const, enum: ["note", "warn", "critical"] },
            claim: { type: "string" as const },
            evidence: { type: "string" as const, description: "Quote the specific numbers or items from the evidence pack" },
            suggestion: { type: "string" as const },
            command: { type: "string" as const, description: "A short message to Kairos that would enact the suggestion, e.g. 'move X to next week'" },
          },
          required: ["severity", "claim", "evidence"],
          additionalProperties: false,
        },
      },
    },
    required: ["findings"],
    additionalProperties: false,
  };

  const perspectiveCall = async (p: Perspective): Promise<CouncilFinding[]> => {
    const res = await client.messages.create({
      model,
      max_tokens: 2000,
      system: `You are the ${p} on a person's personal council. Your charter: ${CHARTERS[p]}\nYou see one evidence pack about their week. Produce at most 3 findings, only ones you can back with specific evidence from the pack. Be blunt and concrete. Severity: critical = a deadline or health cost is likely; warn = a real problem forming; note = worth knowing. If you have nothing worth saying, return an empty findings array.`,
      messages: [{ role: "user", content: `Question: ${q}\n\nEvidence pack:\n${pack}` }],
      output_config: { format: { type: "json_schema", schema: findingsSchema } } as never,
    } as Anthropic.MessageCreateParamsNonStreaming);
    const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    try {
      const parsed = JSON.parse(text) as { findings: Omit<CouncilFinding, "perspective">[] };
      return parsed.findings.map((f) => ({ ...f, perspective: p }));
    } catch {
      return [];
    }
  };

  const settled = await Promise.allSettled(PERSPECTIVES.map(perspectiveCall));
  const findings = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
  const order: Record<CouncilFinding["severity"], number> = { critical: 0, warn: 1, note: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  const synthRes = await client.messages.create({
    model,
    max_tokens: 800,
    system: "You chair a personal council. You are given the members' findings about someone's week. Write a synthesis in at most 60 words, plain text, no headers, naming where the members disagree if they do. Then on a new line starting with 'DECISION:' give the single most important thing to do next, in one sentence, imperative.",
    messages: [{ role: "user", content: `Question: ${q}\n\nFindings:\n${findings.map((f) => `- [${f.severity}] ${f.perspective}: ${f.claim} (${f.evidence})${f.suggestion ? ` → ${f.suggestion}` : ""}`).join("\n") || "(none)"}` }],
  });
  const synthText = synthRes.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("").trim();
  const [synthesis, decision] = synthText.split(/\nDECISION:\s*/i);
  return { question: q, findings, synthesis: (synthesis ?? synthText).trim(), decision: (decision ?? findings[0]?.suggestion ?? "Keep going.").trim(), mode: "claude", generatedAt: now.toISOString() };
}
