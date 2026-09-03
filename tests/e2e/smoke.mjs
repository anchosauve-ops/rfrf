/**
 * Browser smoke test against a production build.
 *   pnpm build && node tests/e2e/smoke.mjs
 * Env: KAIROS_E2E_URL (default http://127.0.0.1:8797), PW_CHROMIUM (executable path override)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const PORT = 8790 + Math.floor(Math.random() * 100);
const URL = process.env.KAIROS_E2E_URL ?? `http://127.0.0.1:${PORT}`;
const own = !process.env.KAIROS_E2E_URL;
let child;
let dataDir;
let browser;

const assert = (cond, msg) => { if (!cond) throw new Error(`ASSERT: ${msg}`); console.log(`  ✓ ${msg}`); };

async function waitFor(url, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not come up at ${url}`);
}

try {
  if (own) {
    dataDir = mkdtempSync(join(tmpdir(), "kairos-e2e-"));
    child = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", "dist/server/server/index.js"], { env: { ...process.env, PORT: String(PORT), KAIROS_DB: join(dataDir, "e2e.db"), NODE_ENV: "test" }, stdio: ["ignore", "pipe", "pipe"] });
    child.stderr.on("data", (d) => process.stderr.write(d));
    await waitFor(`${URL}/api/health`);
  }
  const health = await (await fetch(`${URL}/api/health`)).json();
  assert(health.ok === true, "health ok");

  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15000);
  const nav = (label) => page.click(`nav.rail button:has-text("${label}")`);
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".modal h2", { timeout: 15000 });
  assert(/Kairos/.test(await page.title()), "page title");
  await page.fill(".modal input[placeholder='Your first name']", "Ada");
  await page.click("button:has-text(\"Start my day\")");
  await page.waitForSelector("h1.display", { timeout: 15000 });
  await page.waitForFunction(() => /Ada/.test(document.querySelector("h1.display")?.textContent ?? ""), null, { timeout: 15000 });
  assert(true, "onboarding completes and greets by name");
  await page.waitForFunction(() => document.querySelectorAll(".plan-row").length > 3, null, { timeout: 20000 });
  assert(true, "day plan rendered");

  await page.fill("input[aria-label=Command]", "remind me to water the plants tomorrow at 9");
  await page.press("input[aria-label=Command]", "Enter");
  await page.waitForFunction(() => document.body.innerText.includes("Water the plants"), null, { timeout: 15000 });
  assert(true, "natural-language capture creates a task");
  await page.keyboard.press("Escape"); // collapse the thread overlay

  await nav("Futures");
  await page.waitForSelector(".riskbar", { timeout: 15000 });
  assert((await page.locator(".riskbar").count()) > 0, "futures renders risk bars");
  await page.click("button:has-text(\"Convene\")");
  await page.waitForSelector(".verdict .d", { timeout: 20000 });
  assert(((await page.locator(".verdict .d").textContent()) ?? "").length > 0, "council reaches a decision");

  await nav("Mirror");
  await page.waitForSelector(".bias", { timeout: 15000 });
  assert((await page.locator(".bias").count()) === 4, "mirror shows four energy bias rows");

  await nav("Memory");
  await page.waitForSelector(".mem", { timeout: 15000 });
  assert((await page.locator(".mem").count()) > 0, "memory shows entries with provenance");

  const fatal = pageErrors.filter((e) => !/ERR_CONNECTION|fonts\.g/.test(e));
  assert(fatal.length === 0, `no page errors (${fatal.join("; ") || "none"})`);
  console.log("\nE2E OK");
} catch (e) {
  console.error("\nE2E FAILED:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  child?.kill("SIGTERM");
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
}
