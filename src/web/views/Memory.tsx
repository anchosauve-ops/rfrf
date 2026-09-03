import { useMemo, useState } from "react";
import type { Memory } from "@core/types";
import { api, emitLocal } from "../lib/api";
import { runCommand, useResource } from "../lib/store";
import { fmtDay } from "../lib/time";
import { I } from "../components/Icons";

const KINDS: Memory["kind"][] = ["goal", "preference", "insight", "relationship", "fact", "episode"];
const LABEL: Record<Memory["kind"], string> = { goal: "Goals", preference: "How you work", insight: "Patterns I've noticed", relationship: "People & dates", fact: "Facts", episode: "Episodes" };

export function MemoryView() {
  const [q, setQ] = useState("");
  const { data, reload } = useResource<Memory[]>(q.trim() ? `/memories?q=${encodeURIComponent(q)}` : "/memories", ["memory"], [q]);
  const [openId, setOpenId] = useState<string>();
  const grouped = useMemo(() => {
    const g = new Map<Memory["kind"], Memory[]>();
    for (const m of data ?? []) g.set(m.kind, [...(g.get(m.kind) ?? []), m]);
    return g;
  }, [data]);

  const pin = async (m: Memory) => { await api.patch(`/memories/${m.id}`, { pinned: !m.pinned }); emitLocal({ type: "mutation", entity: "memory" }); reload(); };
  const forget = async (m: Memory) => { if (!confirm(`Forget "${m.text}"?`)) return; await api.del(`/memories/${m.id}`); emitLocal({ type: "mutation", entity: "memory" }); reload(); };
  const adjust = async (m: Memory, d: number) => { await api.patch(`/memories/${m.id}`, { confidence: Math.max(0.05, Math.min(1, m.confidence + d)) }); emitLocal({ type: "mutation", entity: "memory" }); reload(); };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="display" style={{ fontSize: 36 }}>What I know</h1>
          <p className="sub">{data?.length ?? 0} memories · every one has a source, a confidence, and a delete button. Nothing here is hidden from you.</p>
        </div>
      </div>
      <form className="capture" onSubmit={(e) => e.preventDefault()}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search memory, or tell me something new below" aria-label="Search memory" />
        <span className="hint">{q ? "ranked by relevance × importance × recency" : ""}</span>
      </form>
      <div className="row" style={{ gap: 6, margin: "10px 0 4px", flexWrap: "wrap" }}>
        <button className="btn sm ghost" onClick={() => runCommand("remember that ")}>+ Tell me something</button>
        <button className="btn sm ghost" onClick={() => runCommand("what do you know about me")}>Ask me what I know</button>
      </div>

      {(data?.length ?? 0) === 0 && <div className="empty" style={{ marginTop: 20 }}><span className="serif">A blank slate.</span>Say “remember I prefer mornings for deep work” and it lands here, with receipts.</div>}

      {KINDS.filter((k) => grouped.has(k)).map((k) => (
        <div key={k}>
          <h2 className="section">{LABEL[k]} <span className="muted" style={{ fontWeight: 400, letterSpacing: 0 }}>{grouped.get(k)!.length}</span></h2>
          <div className="stack">
            {grouped.get(k)!.map((m) => (
              <div className="mem" key={m.id}>
                <div className="row between" style={{ alignItems: "flex-start" }}>
                  <div className="text" style={{ cursor: "pointer" }} onClick={() => setOpenId(openId === m.id ? undefined : m.id)}>{m.pinned && <I.pin style={{ width: 14, height: 14, color: "var(--accent)", verticalAlign: -2, marginRight: 6 }} />}{m.text}</div>
                  <div className="row" style={{ gap: 2, flex: "none" }}>
                    <button className="btn icon ghost" title={m.pinned ? "Unpin" : "Pin (never fades)"} onClick={() => void pin(m)}><I.pin /></button>
                    <button className="btn icon ghost" title="Forget" onClick={() => void forget(m)}><I.trash /></button>
                  </div>
                </div>
                <div className="row small muted" style={{ gap: 10 }}>
                  <span className={`badge ${m.source === "inferred" ? "accent" : ""}`}>{m.source}</span>
                  <span>confidence</span>
                  <div className="conf"><i style={{ width: `${Math.round(m.confidence * 100)}%`, background: m.confidence < 0.6 ? "var(--accent)" : "var(--ok)" }} /></div>
                  <span>{Math.round(m.confidence * 100)}%</span>
                  <button className="btn sm ghost" title="That's right" onClick={() => void adjust(m, 0.1)}>✓ right</button>
                  <button className="btn sm ghost" title="That's off" onClick={() => void adjust(m, -0.2)}>✗ off</button>
                  <span style={{ marginLeft: "auto" }}>{fmtDay(m.createdAt)}{m.accessCount ? ` · used ${m.accessCount}×` : ""}</span>
                </div>
                {openId === m.id && m.evidence && <div className="evidence">“{m.evidence}”</div>}
                {openId === m.id && !m.evidence && <div className="muted small">No quoted evidence stored for this one.</div>}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
