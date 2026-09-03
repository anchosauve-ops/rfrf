import type { Nudge } from "@core/types";
import { api, emitLocal } from "../lib/api";
import { runCommand, useResource } from "../lib/store";
import { I } from "./Icons";

export function Nudges({ limit = 4 }: { limit?: number }) {
  const { data, reload } = useResource<Nudge[]>("/nudges", ["nudge"]);
  const list = (data ?? []).slice(0, limit);
  if (!list.length) return null;
  const dismiss = async (id: string) => {
    await api.post(`/nudges/${id}/dismiss`);
    emitLocal({ type: "mutation", entity: "nudge" });
    reload();
  };
  return (
    <div className="stack" style={{ marginBottom: 20 }}>
      {list.map((n) => (
        <div className="nudge" data-level={n.level} key={n.id}>
          <div className="bar" />
          <div>
            <div className="t">{n.title}</div>
            <div className="b">{n.body}</div>
            {(n.actions?.length ?? 0) > 0 && (
              <div className="acts">
                {n.actions!.map((a, i) => (
                  <button key={i} className={`btn sm ${a.style === "primary" ? "primary" : a.style === "danger" ? "danger" : ""}`} onClick={() => { runCommand(a.command); void dismiss(n.id); }}>
                    {a.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="x" onClick={() => void dismiss(n.id)} aria-label="Dismiss"><I.x /></button>
        </div>
      ))}
    </div>
  );
}
