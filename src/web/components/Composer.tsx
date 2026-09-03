import { useEffect, useRef, useState } from "react";
import type { AgentEvent, Card, Turn } from "@core/types";
import { api, emitLocal, streamAgent } from "../lib/api";
import { registerCommandHandler, refreshContext, useNow, useStore, toast } from "../lib/store";
import { listen, speak, speechSupported, stopSpeaking } from "../lib/speech";
import { CardView } from "./Cards";
import { I } from "./Icons";

interface LiveTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  cards: Card[];
  tools: { name: string; ok?: boolean; summary?: string }[];
  thinking?: string;
  streaming?: boolean;
  mode?: "claude" | "local";
  error?: string;
}

const SUGGESTIONS = ["plan my day", "what's at risk", "convene the council", "what have you learned about me", "who should I reach out to"];

export function Composer() {
  const [text, setText] = useState("");
  const [turns, setTurns] = useState<LiveTurn[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mic, setMic] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController>(undefined);
  const stopMic = useRef<() => void>(undefined);
  const voice = useStore((s) => s.ctx?.prefs.voice);
  const mode = useStore((s) => s.ctx?.mode);
  const now = useNow(15_000);

  useEffect(() => {
    api.get<Turn[]>("/agent/history?limit=20").then((h) => {
      setTurns(h.filter((t) => t.role !== "system").map((t) => ({ id: t.id, role: t.role as "user" | "assistant", text: t.text, cards: t.cards ?? [], tools: [] })));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const el = threadRef.current;
    if (el && open) el.scrollTop = el.scrollHeight;
  }, [turns, open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      } else if (e.key === "Escape") {
        setOpen(false);
      } else if (e.key === "/" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const send = async (message: string) => {
    const msg = message.trim();
    if (!msg || busy) return;
    setText("");
    setOpen(true);
    setBusy(true);
    stopSpeaking();
    const userTurn: LiveTurn = { id: `u_${Date.now()}`, role: "user", text: msg, cards: [], tools: [] };
    const asst: LiveTurn = { id: `a_${Date.now()}`, role: "assistant", text: "", cards: [], tools: [], streaming: true };
    setTurns((t) => [...t, userTurn, asst]);
    const update = (fn: (a: LiveTurn) => LiveTurn) => setTurns((t) => t.map((x) => (x.id === asst.id ? fn(x) : x)));
    const ac = new AbortController();
    abortRef.current = ac;
    const mutated = new Set<string>();
    try {
      await streamAgent(
        msg,
        "main",
        (ev: AgentEvent) => {
          switch (ev.type) {
            case "start": update((a) => ({ ...a, mode: ev.mode })); break;
            case "text": update((a) => ({ ...a, text: a.text + ev.delta })); break;
            case "thinking": update((a) => ({ ...a, thinking: (a.thinking ?? "") + ev.delta })); break;
            case "tool_start": update((a) => ({ ...a, tools: [...a.tools, { name: ev.name }] })); break;
            case "tool_end": update((a) => ({ ...a, tools: a.tools.map((t, i, arr) => (i === arr.length - 1 && t.name === ev.name ? { ...t, ok: ev.ok, summary: ev.summary } : t)) })); break;
            case "card": update((a) => ({ ...a, cards: [...a.cards, ev.card] })); break;
            case "mutation": mutated.add(ev.entity); break;
            case "error": update((a) => ({ ...a, error: ev.message })); break;
            case "done":
              update((a) => ({ ...a, streaming: false, text: ev.text || a.text }));
              if (voice && ev.text) speak(ev.text);
              break;
          }
        },
        ac.signal,
      );
    } catch (e) {
      update((a) => ({ ...a, streaming: false, error: e instanceof Error ? e.message : "Something broke." }));
    } finally {
      setBusy(false);
      for (const m of mutated) emitLocal({ type: "mutation", entity: m });
      if (mutated.size) void refreshContext();
    }
  };

  useEffect(() => registerCommandHandler((t) => void send(t)), [busy, voice]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const cmd = new URLSearchParams(location.search).get("cmd");
    if (cmd) {
      history.replaceState(null, "", location.pathname + location.hash);
      setTimeout(() => void send(cmd), 300);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleMic = () => {
    if (mic) {
      stopMic.current?.();
      setMic(false);
      return;
    }
    if (!speechSupported()) {
      toast("Voice input isn't available in this browser");
      return;
    }
    setMic(true);
    let finalText = "";
    stopMic.current = listen(
      (t, final) => {
        setText(t);
        if (final) finalText = t;
      },
      () => {
        setMic(false);
        if (finalText.trim()) void send(finalText);
      },
    );
  };

  const clear = async () => {
    await api.del("/agent/history?conversationId=main");
    setTurns([]);
    setOpen(false);
  };

  return (
    <div className="composer-wrap">
      <div className="composer-inner">
        {open && turns.length > 0 && (
          <div className="thread" ref={threadRef} role="log" aria-live="polite">
            <div className="thread-head">
              <span>{mode === "claude" ? "Kairos · Claude" : "Kairos · Local Mind"}</span>
              <span className="row" style={{ gap: 4 }}>
                <button className="btn sm ghost" onClick={clear}>Clear</button>
                <button className="btn sm ghost" onClick={() => setOpen(false)} aria-label="Collapse"><I.chevron /></button>
              </span>
            </div>
            {turns.slice(-30).map((t) => (
              <div key={t.id} className={`turn ${t.role}`}>
                {t.role === "user" ? (
                  <div className="bubble">{t.text}</div>
                ) : (
                  <>
                    {t.thinking && t.streaming && <div className="thinking">{t.thinking.slice(-160)}</div>}
                    {t.tools.length > 0 && (
                      <div className="tools">
                        {t.tools.map((tl, i) => (
                          <span key={i} className={`badge ${tl.ok === false ? "danger" : ""}`} title={tl.summary}>
                            {tl.ok === undefined ? "…" : tl.ok ? "✓" : "✗"} {tl.name}
                          </span>
                        ))}
                      </div>
                    )}
                    {t.error && <div className="badge danger" style={{ marginBottom: 6 }}>{t.error}</div>}
                    {(t.text || t.streaming) && <div className={`text ${t.streaming && !t.cards.length ? "caret" : ""}`}>{t.text}</div>}
                    {t.cards.length > 0 && <div className="cards">{t.cards.map((c, i) => <CardView key={i} card={c} now={now} />)}</div>}
                  </>
                )}
              </div>
            ))}
          </div>
        )}
        {!open && turns.length === 0 && (
          <div className="suggest">
            {SUGGESTIONS.map((s) => <button key={s} onClick={() => void send(s)}>{s}</button>)}
          </div>
        )}
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send(text);
          }}
        >
          <I.spark style={{ width: 18, height: 18, color: "var(--accent)", flex: "none" }} />
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onFocus={() => turns.length && setOpen(true)}
            placeholder={mic ? "Listening…" : busy ? "Thinking…" : "Tell Kairos anything — a task, a time, a thought"}
            aria-label="Command"
            autoComplete="off"
          />
          {!text && !busy && <span className="kbd" style={{ marginRight: 4 }}>⌘K</span>}
          <button type="button" className="btn icon ghost mic" data-on={mic} onClick={toggleMic} aria-label="Voice input" title="Voice input"><I.mic /></button>
          <button type="submit" className="btn icon primary" disabled={!text.trim() || busy} aria-label="Send"><I.send /></button>
        </form>
      </div>
    </div>
  );
}
