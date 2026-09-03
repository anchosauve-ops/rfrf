import Anthropic from "@anthropic-ai/sdk";
import type { Services } from "../services.js";
import { buildTools } from "./tools.js";
import { runLocal } from "./local.js";
import { runClaude } from "./claude.js";
import { claudeCouncil } from "./council.js";
import type { AgentEvent, CouncilVerdict } from "../../core/index.js";

export interface AgentDeps {
  svc: Services;
  apiKey?: () => string | undefined;
  now?: () => Date;
}

export type AgentMode = "claude" | "local";

export class Agent {
  readonly tools;
  constructor(private deps: AgentDeps) {
    this.tools = buildTools(deps.svc);
  }

  apiKey(): string | undefined {
    return this.deps.apiKey?.() ?? process.env.ANTHROPIC_API_KEY ?? this.deps.svc.repo.getMeta("anthropic_api_key") ?? undefined;
  }

  mode(): AgentMode {
    return this.apiKey() ? "claude" : "local";
  }

  /** Council: Claude perspectives when a key exists, deterministic critics otherwise. Never throws. */
  async council(question?: string): Promise<CouncilVerdict> {
    const now = this.deps.now?.() ?? new Date();
    const key = this.apiKey();
    if (key) {
      try {
        return await claudeCouncil(new Anthropic({ apiKey: key }), this.deps.svc.prefs().model, this.deps.svc, now, question);
      } catch (e) {
        const local = this.deps.svc.localCouncil(now, question);
        return { ...local, synthesis: `${local.synthesis} (Model council unavailable: ${e instanceof Anthropic.APIError ? `API ${e.status}` : "error"}; this is the local council.)` };
      }
    }
    return this.deps.svc.localCouncil(now, question);
  }

  async *run(message: string, conversationId: string): AsyncGenerator<AgentEvent> {
    const svc = this.deps.svc;
    const now = this.deps.now?.() ?? new Date();
    const key = this.apiKey();
    svc.repo.addTurn({ conversationId, role: "user", text: message });

    let finalText = "";
    let finalCards: AgentEvent[] = [];
    const record = (ev: AgentEvent) => {
      if (ev.type === "done") {
        finalText = ev.text;
        finalCards = [];
        svc.repo.addTurn({ conversationId, role: "assistant", text: ev.text, cards: ev.cards });
      }
    };

    if (key) {
      const client = new Anthropic({ apiKey: key });
      const history = svc.repo.listTurns(conversationId, 30).slice(0, -1);
      try {
        for await (const ev of runClaude(message, { client, model: svc.prefs().model, tools: this.tools, svc, history, now })) {
          record(ev);
          yield ev;
        }
        return;
      } catch (e) {
        const msg =
          e instanceof Anthropic.AuthenticationError ? "The API key was rejected. Falling back to Local Mind."
          : e instanceof Anthropic.RateLimitError ? "Rate limited by the API. Falling back to Local Mind for this one."
          : e instanceof Anthropic.APIConnectionError ? "Couldn't reach the API. Falling back to Local Mind."
          : e instanceof Anthropic.APIError ? `API error ${e.status}: ${e.message}. Falling back to Local Mind.`
          : `Model error: ${e instanceof Error ? e.message : String(e)}. Falling back to Local Mind.`;
        yield { type: "error", message: msg };
      }
    }
    for await (const ev of runLocal(message, this.tools, svc, now)) {
      record(ev);
      yield ev;
    }
    void finalText;
    void finalCards;
  }
}
