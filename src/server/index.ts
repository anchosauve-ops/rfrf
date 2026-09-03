import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const KAIROS_VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const rel of ["../../../package.json", "../../package.json", "../package.json"]) {
      try { return `v${(JSON.parse(readFileSync(join(here, rel), "utf8")) as { version: string }).version}`; } catch { /* next */ }
    }
  } catch { /* ignore */ }
  return "";
})();

const port = Number(process.env.PORT ?? 8787);
const hostname = process.env.HOST ?? "127.0.0.1";
const dbPath = process.env.KAIROS_DB ?? "./data/kairos.db";
const { app, scheduler, agent } = createApp({ dbPath });
scheduler.start();

serve({ fetch: app.fetch, port, hostname }, () => {
  const mode = agent.mode();
  console.log(`\n  ◐ Kairos ${KAIROS_VERSION} is up on http://${hostname === "0.0.0.0" ? "localhost" : hostname}:${port}`);
  console.log(`    db: ${dbPath}`);
  console.log(`    brain: ${mode === "claude" ? "Claude (" + agent["deps"].svc.prefs().model + ")" : "Local Mind — add ANTHROPIC_API_KEY to wake the model"}\n`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    scheduler.stop();
    process.exit(0);
  });
}
