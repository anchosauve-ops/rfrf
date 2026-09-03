/**
 * Memory — what Kairos knows about you, with receipts.
 *
 * Every memory carries a source (stated / inferred / imported), confidence,
 * importance, and the evidence it came from. Retrieval blends lexical match,
 * importance, and time-decay whose half-life depends on the kind of memory:
 * facts and relationships fade slowly, episodes fade fast.
 */
import type { Memory, MemoryKind, MemorySource } from "./types.js";

const STOP = new Set(
  "a an the and or but if then of to in on at for from by with about as is are was were be been being i me my mine you your yours we our us it its this that these those do does did have has had not no yes so very just really also can could should would will shall may might must am im ive dont cant wont what which who whom when where why how all any some more most other into over under again further once here there".split(" "),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .replace(/'/g, "")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

export function stem(t: string): string {
  if (t.length <= 4) return t;
  let w = t.replace(/ies$/, "y").replace(/(?<=[^s])(es|s)$/, "");
  if (w.length > 4) w = w.replace(/(ing|edly|ed|ly)$/, "");
  return w.length >= 3 ? w : t;
}

const HALF_LIFE_DAYS: Record<MemoryKind, number> = {
  fact: 365,
  relationship: 365,
  preference: 240,
  goal: 120,
  insight: 90,
  episode: 21,
};

export function recencyFactor(m: Memory, now: Date): number {
  if (m.pinned) return 1;
  const anchor = new Date(m.lastAccessedAt ?? m.updatedAt ?? m.createdAt).getTime();
  const days = Math.max(0, (now.getTime() - anchor) / 86400000);
  const hl = HALF_LIFE_DAYS[m.kind];
  return Math.pow(0.5, days / hl);
}

export interface Scored<T> {
  item: T;
  score: number;
  why: string[];
}

export function scoreMemory(m: Memory, queryTokens: string[], now: Date): Scored<Memory> {
  const why: string[] = [];
  const mt = new Set(tokenize(m.text).concat(m.tags.map(stem)));
  let overlap = 0;
  for (const q of queryTokens) if (mt.has(q)) overlap++;
  const lexical = queryTokens.length ? overlap / Math.sqrt(queryTokens.length) : 0.4;
  if (overlap) why.push(`matches ${overlap} term${overlap > 1 ? "s" : ""}`);
  const rec = recencyFactor(m, now);
  const usage = Math.log1p(m.accessCount) * 0.05;
  let score = lexical * (0.55 + m.importance * 0.6) * (0.5 + rec * 0.5) + m.importance * 0.08 + usage;
  score *= 0.6 + m.confidence * 0.4;
  if (m.pinned) {
    score += 0.15;
    why.push("pinned");
  }
  if (rec < 0.3) why.push("fading");
  if (m.expiresAt && new Date(m.expiresAt) < now) score *= 0.2;
  return { item: m, score, why };
}

export function recall(memories: Memory[], query: string, opts: { now: Date; limit?: number; minScore?: number }): Scored<Memory>[] {
  const q = tokenize(query);
  const limit = opts.limit ?? 8;
  const min = opts.minScore ?? (q.length ? 0.12 : 0);
  return memories
    .map((m) => scoreMemory(m, q, opts.now))
    .filter((s) => s.score >= min)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Jaccard similarity over stemmed tokens. */
export function similarity(a: string, b: string): number {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export function findDuplicate(memories: Memory[], text: string, threshold = 0.72): Memory | undefined {
  let best: { m: Memory; s: number } | undefined;
  for (const m of memories) {
    const s = similarity(m.text, text);
    if (s >= threshold && (!best || s > best.s)) best = { m, s };
  }
  return best?.m;
}

export interface MemoryCandidate {
  text: string;
  kind: MemoryKind;
  importance: number;
  confidence: number;
  source: MemorySource;
  evidence: string;
  tags: string[];
}

const PATTERNS: { re: RegExp; kind: MemoryKind; importance: number; confidence: number }[] = [
  { re: /\b(?:my goal|i(?:'m| am) trying to|i want to|i intend to|i plan to|this (?:quarter|year|month) i)\b.+/i, kind: "goal", importance: 0.85, confidence: 0.85 },
  { re: /\bi (?:prefer|like|love|enjoy|hate|dislike|can't stand|avoid)\b.+/i, kind: "preference", importance: 0.7, confidence: 0.85 },
  { re: /\bi (?:usually|always|never|tend to|typically|normally)\b.+/i, kind: "preference", importance: 0.65, confidence: 0.75 },
  { re: /\bi(?:'m| am) (?:most|least) (?:productive|focused|creative)\b.+/i, kind: "preference", importance: 0.8, confidence: 0.8 },
  { re: /\bmy (?:wife|husband|partner|boss|manager|mom|mother|dad|father|sister|brother|son|daughter|kid|kids|best friend|team|cofounder|co-founder|therapist|doctor)\b.+/i, kind: "relationship", importance: 0.75, confidence: 0.85 },
  { re: /\b(?:birthday|anniversary) (?:is|on)\b.+/i, kind: "relationship", importance: 0.8, confidence: 0.9 },
  { re: /\bi (?:work|live|am based) (?:at|in|for)\b.+/i, kind: "fact", importance: 0.6, confidence: 0.85 },
  { re: /\bi(?:'m| am) (?:a|an) [a-z -]+\b/i, kind: "fact", importance: 0.5, confidence: 0.7 },
  { re: /\bi (?:learned|realized|noticed|figured out)\b.+/i, kind: "insight", importance: 0.6, confidence: 0.7 },
];

/** Pull memory-worthy statements out of free text (used when no model is available, and as a safety net when one is). */
export function extractCandidates(text: string, source: MemorySource = "inferred"): MemoryCandidate[] {
  const out: MemoryCandidate[] = [];
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  for (const s of sentences) {
    for (const p of PATTERNS) {
      const m = p.re.exec(s);
      if (m) {
        const clean = m[0].replace(/[.!?]+$/, "").trim();
        out.push({ text: clean[0]!.toUpperCase() + clean.slice(1), kind: p.kind, importance: p.importance, confidence: source === "stated" ? Math.max(p.confidence, 0.9) : p.confidence, source, evidence: s, tags: [] });
        break;
      }
    }
  }
  return out;
}

/** A compact profile for the system prompt: strongest memories, grouped. */
export function profileSummary(memories: Memory[], now: Date, maxPerKind = 6): string {
  const kinds: MemoryKind[] = ["fact", "preference", "goal", "relationship", "insight", "episode"];
  const lines: string[] = [];
  for (const k of kinds) {
    const items = memories
      .filter((m) => m.kind === k)
      .map((m) => ({ m, s: m.importance * (0.5 + recencyFactor(m, now) * 0.5) + (m.pinned ? 1 : 0) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, maxPerKind);
    if (!items.length) continue;
    lines.push(`${k.toUpperCase()}:`);
    for (const { m } of items) lines.push(`- ${m.text}${m.source === "inferred" ? ` (inferred, ${Math.round(m.confidence * 100)}%)` : ""}`);
  }
  return lines.join("\n");
}
