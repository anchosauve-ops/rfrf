import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8787);
const dbPath = process.env.KAIROS_DB ?? "./data/kairos.db";
const { app, scheduler, agent } = createApp({ dbPath });
scheduler.start();

serve({ fetch: app.fetch, port }, () => {
  const mode = agent.mode();
  console.log(`\n  ◐ Kairos is up on http://localhost:${port}`);
  console.log(`    db: ${dbPath}`);
  console.log(`    brain: ${mode === "claude" ? "Claude (" + agent["deps"].svc.prefs().model + ")" : "Local Mind — add ANTHROPIC_API_KEY to wake the model"}\n`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    scheduler.stop();
    process.exit(0);
  });
}
