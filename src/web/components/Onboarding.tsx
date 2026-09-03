import { useState } from "react";
import { api, emitLocal } from "../lib/api";
import { refreshContext } from "../lib/store";

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [tz, setTz] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [key, setKey] = useState("");
  const [demo, setDemo] = useState(true);
  const [busy, setBusy] = useState(false);
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [tz];

  const go = async () => {
    setBusy(true);
    try {
      await api.put("/prefs", { name: name.trim(), timezone: tz, onboarded: true, ...(key.trim() ? { apiKey: key.trim() } : {}) });
      if (demo) await api.post("/demo");
      await api.post("/plan");
      await refreshContext();
      for (const e of ["task", "event", "memory", "person", "plan", "prefs"]) emitLocal({ type: "mutation", entity: e });
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-bg">
      <div className="modal">
        <h2>Hello. I'm <em style={{ color: "var(--accent)" }}>Kairos</em>.</h2>
        <p className="muted" style={{ marginTop: 0 }}>I run your day: plan your time around your energy, remember what matters, and speak up before things slip. Everything stays on this machine.</p>
        <div className="stack" style={{ gap: 14, marginTop: 18 }}>
          <label className="field"><span>What should I call you?</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your first name" autoFocus /></label>
          <label className="field"><span>Timezone</span>
            <select className="select" value={tz} onChange={(e) => setTz(e.target.value)}>{zones.map((z) => <option key={z}>{z}</option>)}</select>
          </label>
          <label className="field"><span>Anthropic API key <span className="muted">(optional — without it I run on the Local Mind)</span></span><input className="input" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-ant-…" /></label>
          <label className="row" style={{ gap: 10, cursor: "pointer" }}>
            <button type="button" className="switch" role="switch" aria-checked={demo} onClick={() => setDemo(!demo)} />
            <span>Load a believable demo day so you can see how it feels</span>
          </label>
        </div>
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 22 }}>
          <button className="btn primary" disabled={busy} onClick={() => void go()}>{busy ? "Setting up…" : "Start my day"}</button>
        </div>
      </div>
    </div>
  );
}
