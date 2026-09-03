# Contributing

Thanks for wanting to make Kairos better.

1. `pnpm install`, then `pnpm dev`. Onboarding offers a demo day.
2. Make the change in the right layer (see `CLAUDE.md`). Core logic gets a test in `tests/`.
3. `pnpm check` must pass: lint, typecheck, 100+ tests, build. `pnpm e2e` runs the browser smoke test if you have Chromium.
4. If you touched a chart color, run the palette validator described in `docs/ARCHITECTURE.md`.
5. Open a pull request against `main` with a short description of what changed and why. Screenshots for UI changes are appreciated; `docs/screenshots` shows the style.

Good first contributions: calendar adapters (CalDAV, Google), more `intent.ts` phrasings with tests, more council critics, translations of the UI strings.
