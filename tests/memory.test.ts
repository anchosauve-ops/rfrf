import { describe, it, expect } from "vitest";
import { recall, extractCandidates, findDuplicate, recencyFactor, profileSummary, tokenize } from "../src/core/memory";
import type { Memory } from "../src/core/types";

const now = new Date("2026-09-03T12:00:00Z");
const M = (id: string, text: string, extra: Partial<Memory> = {}): Memory => ({ id, text, kind: "fact", tags: [], importance: 0.5, confidence: 0.8, source: "stated", pinned: false, accessCount: 0, createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", ...extra });

describe("memory", () => {
  it("tokenizes with stopwords and light stemming", () => {
    expect(tokenize("I prefer deep work before noon")).toEqual(["prefer", "deep", "work", "before", "noon"]);
    expect(tokenize("meetings")).toEqual(["meet"]);
  });
  it("recall ranks lexical matches by importance and recency", () => {
    const ms = [
      M("a", "Prefers deep work before noon", { kind: "preference", importance: 0.9 }),
      M("b", "Likes oat milk in coffee", { kind: "preference", importance: 0.2 }),
      M("c", "Deep work goal: ship v1", { kind: "goal", importance: 0.6, createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z" }),
    ];
    const hits = recall(ms, "deep work", { now });
    expect(hits[0]!.item.id).toBe("a");
    expect(hits.map((h) => h.item.id)).not.toContain("b");
  });
  it("empty query returns strongest memories", () => {
    const hits = recall([M("a", "x", { importance: 0.1 }), M("b", "y", { importance: 0.9, pinned: true })], "", { now });
    expect(hits[0]!.item.id).toBe("b");
  });
  it("episodes fade faster than facts", () => {
    const old = { createdAt: "2026-06-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z" };
    expect(recencyFactor(M("e", "x", { kind: "episode", ...old }), now)).toBeLessThan(recencyFactor(M("f", "x", { kind: "fact", ...old }), now));
    expect(recencyFactor(M("p", "x", { kind: "episode", pinned: true, ...old }), now)).toBe(1);
  });
  it("detects near duplicates", () => {
    const ms = [M("a", "Prefers deep work before noon")];
    expect(findDuplicate(ms, "prefer deep work before noon")?.id).toBe("a");
    expect(findDuplicate(ms, "Loves hiking on weekends")).toBeUndefined();
  });
  it("extracts memory candidates from free text", () => {
    const c = extractCandidates("I usually work out at 6am. My goal is to run a marathon in May. The weather is nice.", "stated");
    expect(c.map((x) => x.kind)).toEqual(["preference", "goal"]);
    expect(c[1]!.text).toMatch(/^My goal is to run a marathon/);
    expect(c[0]!.confidence).toBeGreaterThanOrEqual(0.9);
  });
  it("profile summary groups by kind", () => {
    const s = profileSummary([M("a", "Works at Acme"), M("b", "Prefers mornings", { kind: "preference", source: "inferred", confidence: 0.7 })], now);
    expect(s).toContain("FACT:");
    expect(s).toContain("PREFERENCE:");
    expect(s).toContain("(inferred, 70%)");
  });
});
