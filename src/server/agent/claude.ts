import { uid } from "../ids.js";
/**
 * Claude brain — a streaming tool-use loop over the shared tool registry.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { ToolRegistry } from "./tools.js";
import type { Services } from "../services.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { cardToText, type AgentEvent, type Card, type Turn } from "../../core/index.js";

export interface ClaudeOptions {
  client: Anthropic;
  model: string;
  tools: ToolRegistry;
  svc: Services;
  history: Turn[];
  now?: Date;
  maxIterations?: number;
}

function supportsAdaptiveThinking(model: string): boolean {
  return /^claude-(opus-(4-[6-9]|5)|sonnet-(4-6|5)|fable|mythos)/.test(model);
}
function alwaysThinks(model: string): boolean {
  return /^claude-(fable|mythos)/.test(model);
}

export async function* runClaude(message: string, o: ClaudeOptions): AsyncGenerator<AgentEvent> {
  const now = o.now ?? new Date();
  const turnId = uid("trn");
  yield { type: "start", turnId, mode: "claude" };

  const toolDefs = Object.values(o.tools).map((t) => t.def);
  const messages: Anthropic.MessageParam[] = [];
  for (const h of o.history) {
    if (h.role === "system") continue;
    const text = h.cards?.length ? `${h.text}\n\n${h.cards.map(cardToText).join("\n\n")}` : h.text;
    if (text.trim()) messages.push({ role: h.role, content: text });
  }
  if (messages[0]?.role === "assistant") messages.shift();
  messages.push({ role: "user", content: message });

  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    { type: "text", text: `Context (fresh each turn):\n${o.svc.contextSnapshot(now)}` },
  ];

  const allCards: Card[] = [];
  let fullText = "";
  const maxIter = o.maxIterations ?? 8;

  for (let iter = 0; iter < maxIter; iter++) {
    const params: Anthropic.MessageStreamParams = {
      model: o.model,
      max_tokens: 8000,
      system,
      tools: toolDefs,
      messages,
    };
    if (supportsAdaptiveThinking(o.model)) {
      if (!alwaysThinks(o.model)) params.thinking = { type: "adaptive", display: "summarized" } as Anthropic.ThinkingConfigParam;
      params.output_config = { effort: "medium" } as Anthropic.MessageCreateParams["output_config"];
    }

    const stream = o.client.messages.stream(params);
    let iterText = "";
    for await (const ev of stream) {
      if (ev.type === "content_block_delta") {
        if (ev.delta.type === "text_delta") {
          iterText += ev.delta.text;
          yield { type: "text", delta: ev.delta.text };
        } else if (ev.delta.type === "thinking_delta" && ev.delta.thinking) {
          yield { type: "thinking", delta: ev.delta.thinking };
        }
      }
    }
    const final = await stream.finalMessage();
    fullText += (fullText && iterText ? "\n" : "") + iterText;

    if (final.stop_reason === "refusal") {
      const note = "I can't help with that one.";
      yield { type: "text", delta: iterText ? "" : note };
      fullText = fullText || note;
      break;
    }
    if (final.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: final.content });
      continue;
    }

    const toolUses = final.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (final.stop_reason !== "tool_use" || toolUses.length === 0) break;

    messages.push({ role: "assistant", content: final.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const tool = o.tools[tu.name];
      const input = (tu.input ?? {}) as Record<string, unknown>;
      yield { type: "tool_start", name: tu.name, input };
      let content: string;
      let ok = true;
      if (!tool) {
        content = `Unknown tool ${tu.name}`;
        ok = false;
      } else {
        try {
          const r = tool.run(input, now);
          ok = r.ok !== false;
          content = r.text;
          for (const c of r.cards ?? []) {
            allCards.push(c);
            yield { type: "card", card: c };
          }
          for (const m of r.mutated ?? []) yield { type: "mutation", entity: m };
        } catch (e) {
          ok = false;
          content = `Tool error: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      yield { type: "tool_end", name: tu.name, ok, summary: content.split("\n")[0]!.slice(0, 160) };
      results.push({ type: "tool_result", tool_use_id: tu.id, content, is_error: !ok });
    }
    messages.push({ role: "user", content: results });
  }

  yield { type: "done", turnId, text: fullText.trim(), cards: allCards };
}
