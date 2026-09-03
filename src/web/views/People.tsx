import type { Person } from "@core/types";
import { api, emitLocal } from "../lib/api";
import { runCommand, useNow, useResource, useStore } from "../lib/store";
import { relDay } from "../lib/time";

type P = Person & { staleness: number };

export function PeopleView() {
  const { data, reload } = useResource<P[]>("/people", ["person"]);
  const now = useNow(60_000);
  const tz = useStore((s) => s.ctx?.prefs.timezone);
  const people = [...(data ?? [])].sort((a, b) => b.staleness - a.staleness);
  const touch = async (p: Person) => { await api.post(`/people/${p.id}/touch`); emitLocal({ type: "mutation", entity: "person" }); reload(); };
  const drifting = people.filter((p) => p.staleness >= 1);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="display" style={{ fontSize: 36 }}>People</h1>
          <p className="sub">{people.length} people · {drifting.length ? `${drifting.length} drifting past their cadence` : "nobody drifting"}</p>
        </div>
        <button className="btn primary" onClick={() => runCommand("add person ")}>+ Add someone</button>
      </div>
      {people.length === 0 && <div className="empty"><span className="serif">Nobody yet.</span>Say “met Priya, colleague from design, every 2 weeks” and I'll keep the thread alive.</div>}
      <div className="people-grid">
        {people.map((p) => {
          const pct = Math.min(100, Math.round(p.staleness * 100));
          const color = p.staleness >= 1.25 ? "var(--danger)" : p.staleness >= 0.8 ? "var(--accent)" : "var(--ok)";
          return (
            <div className="person" key={p.id}>
              <div className="ring" style={{ ["--pct" as string]: p.cadenceDays ? pct : 0, ["--ring-color" as string]: color }}><span>{p.name[0]}</span></div>
              <div style={{ minWidth: 0 }}>
                <div className="n">{p.name}</div>
                <div className="r">
                  {p.relation ? `${p.relation} · ` : ""}
                  {p.lastContactAt ? `last ${relDay(p.lastContactAt, now, tz)}` : "never logged"}
                  {p.cadenceDays ? ` · every ${p.cadenceDays}d` : ""}
                </div>
                {p.notes && <div className="r" style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>{p.notes.split("\n").slice(-2).join("\n")}</div>}
              </div>
              <div className="acts">
                <button className="btn sm" onClick={() => void touch(p)}>In touch today</button>
                <button className="btn sm ghost" onClick={() => runCommand(`reach out to ${p.name} tomorrow`)}>Plan a touch</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
