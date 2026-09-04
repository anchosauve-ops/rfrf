/*
 * Kairos ↔ OnlineJobs Timeproof bridge.
 * Loaded by the bookmarklet on a Timeproof calendar page. Reads the visible
 * month, keeps only day totals (blue), and posts them to your local Kairos.
 * Nothing leaves your browser except to the Kairos URL you configured.
 */
(function () {
  const cfg = window.__KAIROS__ || {};
  const server = (cfg.server || "http://127.0.0.1:8787").replace(/\/$/, "");
  const token = cfg.token || "";
  const say = (msg, ok) => {
    let el = document.getElementById("kairos-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "kairos-toast";
      el.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;padding:12px 18px;border-radius:999px;font:14px/1.4 system-ui,sans-serif;color:#fff;box-shadow:0 8px 30px rgba(0,0,0,.3);max-width:90vw";
      document.body.appendChild(el);
    }
    el.style.background = ok === false ? "#b4432f" : ok === true ? "#3f7d5a" : "#1a1917";
    el.textContent = msg;
    clearTimeout(el._t);
    el._t = setTimeout(() => el.remove(), ok === undefined ? 60000 : 8000);
  };

  const monthText = (document.querySelector(".fc-toolbar h2, .fc-header-title h2, .fc-center h2, h2") || {}).textContent || "";
  const mm = /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i.exec(monthText);
  const worker = ((document.querySelector("h1, h2.page-title, .page-header h1") || {}).textContent || "").replace(/['’]s Timeproof.*$/i, "").trim();

  const rgb = (s) => (s.match(/\d+(\.\d+)?/g) || []).map(Number);
  const classify = (el) => {
    const [r, g, b] = rgb(getComputedStyle(el).backgroundColor);
    if (r === undefined) return "day";
    if (g > r && g > b) return "week";        // green
    if (r > 100 && g < 60 && b < 60) return "month"; // dark red
    return "day";                               // blue-ish
  };
  const hm = (t) => /^\d{1,3}:\d{2}$/.test(t.trim()) ? t.trim() : null;

  const days = new Map();
  let used = "grid";
  // Path 1: FullCalendar month grid — map skeleton event cells to background day cells by column.
  const rows = document.querySelectorAll(".fc-row, .fc-week");
  if (rows.length) {
    rows.forEach((row) => {
      const dateCells = Array.from(row.querySelectorAll(".fc-bg td, .fc-day[data-date]")).filter((td) => td.getAttribute("data-date"));
      const dates = dateCells.map((td) => td.getAttribute("data-date"));
      if (!dates.length) return;
      row.querySelectorAll(".fc-content-skeleton tbody tr, .fc-event-container").forEach((tr) => {
        let col = 0;
        Array.from(tr.children).forEach((td) => {
          const span = Number(td.getAttribute("colspan") || 1);
          td.querySelectorAll(".fc-event, .fc-day-grid-event, [class*='event']").forEach((ev) => {
            const t = hm((ev.querySelector(".fc-title") || ev).textContent || "");
            if (t && classify(ev) === "day" && dates[col]) days.set(dates[col], t);
          });
          col += span;
        });
      });
    });
  }
  // Path 2: fall back to the page text and let Kairos disambiguate totals arithmetically.
  let payload;
  if (days.size) {
    payload = { person: worker || undefined, source: "timeproof", days: Array.from(days, ([date, t]) => ({ date, minutes: Number(t.split(":")[0]) * 60 + Number(t.split(":")[1]) })) };
  } else {
    used = "text";
    const cal = document.querySelector(".fc, #calendar, .calendar") || document.body;
    payload = { person: worker || undefined, source: "timeproof", text: (mm ? mm[0] + "\n" : "") + cal.innerText };
  }

  say("Sending " + (days.size ? days.size + " days" : "the calendar text") + " to Kairos…");
  fetch(server + "/api/worklog/import", { method: "POST", headers: { "content-type": "application/json", "x-kairos-token": token }, body: JSON.stringify(payload) })
    .then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || r.status + " " + r.statusText);
      const p = j.payroll;
      say(`Kairos: ${j.person.name} — ${j.days} day(s) via ${used}, ${j.added} new, ${j.updated} updated` + (p ? ` · this month ${Math.floor(p.totalMinutes / 60)}h${p.totalMinutes % 60}m = ${p.currency} ${p.amount.toFixed(2)}` : ""), true);
    })
    .catch((e) => say("Kairos import failed: " + e.message + (/(Failed to fetch|NetworkError)/.test(e.message) ? " — is Kairos running at " + server + "?" : ""), false));
})();
