import { useEffect, useState } from "react";
import { api, emitLocal } from "../lib/api";
import { setState, toast, useStore } from "../lib/store";

export function FocusOverlay() {
  const focus = useStore((s) => s.focus);
  const [left, setLeft] = useState(0);
  const finish = async (outcome: "completed" | "abandoned") => {
    const f = focus;
    setState({ focus: undefined });
    if (f?.id) await api.post(`/focus/${f.id}/end`, { outcome }).catch(() => {});
    if (outcome === "completed") {
      toast(`Focus block done: ${f?.title}`);
      if (f?.taskId) {
        // Offer completion without forcing it.
        setTimeout(() => {
          if (confirm(`Mark "${f.title}" as done?`)) api.post(`/tasks/${f.taskId}/complete`).then(() => emitLocal({ type: "mutation", entity: "task" })).catch(() => {});
        }, 200);
      }
    }
  };
  useEffect(() => {
    if (!focus) return;
    let id = focus.id;
    if (!id) {
      api.post<{ id: string }>("/focus/start", { minutes: focus.minutes, taskId: focus.taskId, title: focus.title }).then((r) => {
        id = r.id;
        setState((s) => (s.focus ? { focus: { ...s.focus, id: r.id } } : {}));
      }).catch(() => {});
    }
    const tick = () => {
      const remaining = focus.minutes * 60 - Math.floor((Date.now() - focus.startedAt) / 1000);
      setLeft(Math.max(0, remaining));
      if (remaining <= 0) {
        void finish("completed");
      }
    };
    tick();
    const t = setInterval(tick, 1000);
    document.title = `Focus · ${focus.title}`;
    return () => {
      clearInterval(t);
      document.title = "Kairos";
    };
  }, [focus?.startedAt]);


  if (!focus) return null;
  const mm = String(Math.floor(left / 60)).padStart(2, "0");
  const ss = String(left % 60).padStart(2, "0");
  return (
    <div className="focus-overlay" role="dialog" aria-label="Focus session">
      <div style={{ textAlign: "center" }}>
        <div className="big">{mm}:{ss}</div>
        <div className="what">{focus.title}</div>
        <div className="row" style={{ justifyContent: "center", gap: 8, marginTop: 28 }}>
          <button className="btn" onClick={() => void finish("abandoned")}>Stop</button>
          <button className="btn primary" onClick={() => void finish("completed")}>Done early</button>
        </div>
        <div className="muted small" style={{ marginTop: 40 }}>Everything else can wait. It usually does.</div>
      </div>
    </div>
  );
}
