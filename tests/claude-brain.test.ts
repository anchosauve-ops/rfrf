/**
 * The Claude brain against a mocked client: the loop, tool dispatch, refusal,
 * pause_turn, the council's structured output, and the fallback to Local Mind.
 * These prove the wiring; a live key proves the model.
 */
import { describe, it, expect } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { createApp, seedDemo } from "../src/server/app.js";
import { runClaude } from "../src/server/agent/claude.js";
import { claudeCouncil } from "../src/server/agent/council.js";
import type { AgentEvent } from "../src/core/index.js";

const now = () => new Date("2026-09-03T12:30:00Z");

type Block = Record<string, unknown>;
interface Scripted { content: Block[]; stop_reason: string }

/** A minimal stand-in for client.messages.stream(): yields text deltas, then finalMessage(). */
function mockClient(script: Scripted[], onParams?: (p: Record<string, unknown>) => void) {
  let i = 0;
  const stream = (params: Record<string, unknown>) => {
    onParams?.(params);
    const msg = script[Math.min(i++, script.length - 1)]!;
    const events = msg.content.filter((b) => b.type === "text").map((b) => ({ type: "content_block_delta", delta: { type: "text_delta", text: b.text } }));
    const it = {
      [Symbol.asyncIterator]: async function* () { for (const e of events) yield e; },
      finalMessage: async () => ({ content: msg.content, stop_reason: msg.stop_reason, usage: { input_tokens: 1, output_tokens: 1 } }),
    };
    return it;
  };
  return { messages: { stream } } as unknown as Anthropic;
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("claude brain (mocked)", () => {
  const ctx = createApp({ now, webDir: "/nonexistent", log: false });
  ctx.repo.setPrefs({ timezone: "America/New_York", name: "Will" });
  seedDemo(ctx.repo, now());
  const agent = ctx.agent;

  it("runs the tool loop: tool_use → executes → feeds results → end_turn, streaming cards and mutations", async () => {
    const seen: Record<string, unknown>[] = [];
    const client = mockClient(
      [
        { content: [{ type: "text", text: "On it." }, { type: "tool_use", id: "tu1", name: "create_task", input: { title: "Call the bank", due: "friday" } }], stop_reason: "tool_use" },
        { content: [{ type: "text", text: "Added it for Friday." }], stop_reason: "end_turn" },
      ],
      (p) => seen.push(p),
    );
    const events = await collect(runClaude("remind me to call the bank by friday", { client, model: "claude-opus-5", tools: agent.tools, svc: ctx.svc, history: [], now: now() }));
    expect(events[0]).toMatchObject({ type: "start", mode: "claude" });
    expect(events.some((e) => e.type === "tool_start" && e.name === "create_task")).toBe(true);
    expect(events.some((e) => e.type === "tool_end" && e.ok)).toBe(true);
    expect(events.some((e) => e.type === "card" && e.card.type === "tasks")).toBe(true);
    expect(events.some((e) => e.type === "mutation" && e.entity === "task")).toBe(true);
    const done = events.find((e) => e.type === "done")!;
    expect(done.type === "done" && done.text).toMatch(/Added it for Friday/);
    expect(ctx.repo.findTask("call the bank")).toBeTruthy();
    // second request carried the tool result back
    const second = seen[1]!.messages as { role: string; content: unknown }[];
    expect(second[second.length - 1]!.role).toBe("user");
    expect(JSON.stringify(second[second.length - 1]!.content)).toContain("tool_result");
    // request shape: adaptive thinking + effort on Opus 5, cached system prompt
    expect(seen[0]!.thinking).toMatchObject({ type: "adaptive" });
    expect((seen[0]!.output_config as { effort: string }).effort).toBe("medium");
    expect((seen[0]!.system as { cache_control?: unknown }[])[0]!.cache_control).toBeTruthy();
  });

  it("omits the thinking parameter for Fable models", async () => {
    const seen: Record<string, unknown>[] = [];
    const client = mockClient([{ content: [{ type: "text", text: "Hi." }], stop_reason: "end_turn" }], (p) => seen.push(p));
    await collect(runClaude("hi", { client, model: "claude-fable-5-1", tools: agent.tools, svc: ctx.svc, history: [], now: now() }));
    expect(seen[0]!.thinking).toBeUndefined();
  });

  it("handles refusal and pause_turn without crashing", async () => {
    const refused = await collect(runClaude("x", { client: mockClient([{ content: [], stop_reason: "refusal" }]), model: "claude-opus-5", tools: agent.tools, svc: ctx.svc, history: [], now: now() }));
    expect(refused.find((e) => e.type === "done")).toMatchObject({ text: expect.stringMatching(/can't help/) });
    const paused = await collect(runClaude("x", { client: mockClient([{ content: [{ type: "text", text: "…" }], stop_reason: "pause_turn" }, { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" }]), model: "claude-opus-5", tools: agent.tools, svc: ctx.svc, history: [], now: now() }));
    expect(paused.find((e) => e.type === "done")).toMatchObject({ text: expect.stringMatching(/done/) });
  });

  it("reports unknown tools and tool errors as is_error results, and keeps going", async () => {
    const client = mockClient([
      { content: [{ type: "tool_use", id: "tu1", name: "no_such_tool", input: {} }], stop_reason: "tool_use" },
      { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" },
    ]);
    const events = await collect(runClaude("x", { client, model: "claude-opus-5", tools: agent.tools, svc: ctx.svc, history: [], now: now() }));
    expect(events.some((e) => e.type === "tool_end" && e.ok === false)).toBe(true);
    expect(events.find((e) => e.type === "done")).toBeTruthy();
  });

  it("council: five structured perspective calls plus a chair, sorted by severity", async () => {
    const calls: Record<string, unknown>[] = [];
    const client = {
      messages: {
        create: async (params: Record<string, unknown>) => {
          calls.push(params);
          const sys = String(params.system);
          if (sys.startsWith("You chair")) return { content: [{ type: "text", text: "They disagree on scope.\nDECISION: Cut the offsite prep to one hour." }] };
          const who = /You are the (\w+)/.exec(sys)![1];
          const sev = who === "realist" ? "critical" : who === "guardian" ? "warn" : "note";
          return { content: [{ type: "text", text: JSON.stringify({ findings: [{ severity: sev, claim: `${who} says`, evidence: "numbers", suggestion: "do x", command: "plan my day" }] }) }] };
        },
      },
    } as unknown as Anthropic;
    const v = await claudeCouncil(client, "claude-opus-5", ctx.svc, now(), "what should I cut?");
    expect(v.mode).toBe("claude");
    expect(calls.length).toBe(6);
    expect((calls[0]!.output_config as { format: { type: string } }).format.type).toBe("json_schema");
    expect(v.findings.length).toBe(5);
    expect(v.findings[0]!.severity).toBe("critical");
    expect(v.decision).toBe("Cut the offsite prep to one hour.");
    expect(v.synthesis).toMatch(/disagree/);
  });

  it("falls back to Local Mind when the API rejects the key, and says so", async () => {
    const fallback = createApp({ now, webDir: "/nonexistent", log: false, apiKey: () => "sk-ant-api03-" + "x".repeat(40) });
    fallback.repo.setPrefs({ timezone: "America/New_York" });
    // Point the SDK at a dead endpoint so the failure is a connection error, not a live call.
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
    try {
      const events = await collect(fallback.agent.run("what's overdue", "main"));
      expect(events.some((e) => e.type === "error" && /Falling back to Local Mind/.test(e.message))).toBe(true);
      expect(events.some((e) => e.type === "start" && e.mode === "local")).toBe(true);
      expect(events.find((e) => e.type === "done")).toBeTruthy();
    } finally {
      delete process.env.ANTHROPIC_BASE_URL;
    }
  }, 30_000);
});
