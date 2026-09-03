# Security

## Model

Kairos is single-user and local-first. The server is meant to run on the person's own machine or in a container they control, bound to `127.0.0.1` by default. There are no accounts and no multi-tenant surface. If you expose it beyond localhost, put it behind something that authenticates (a reverse proxy with auth, Tailscale, a VPN); Kairos itself does not.

## What is stored, and how

- Everything lives in one SQLite file (`KAIROS_DB`).
- The Anthropic API key, when saved through the UI, is encrypted at rest with AES-256-GCM. The key material is `KAIROS_SECRET` if set, otherwise a random secret generated once into `.kairos-secret` next to the database with `0600` permissions. Prefer `ANTHROPIC_API_KEY` in the environment for deployments.
- Daily JSON backups are written next to the database (`backups/`, `0600`, 14 kept). They contain everything, including memories. Treat the data directory as sensitive.

## Network

- Outbound: only the Anthropic API, and only when a key is present. The Local Mind makes no network calls.
- Inbound: `/api/*` accepts browser requests only from the app's own origin and local dev origins (`KAIROS_ALLOWED_ORIGINS` to extend). Request bodies are capped (2 MB; 25 MB for import). All writes are validated and bounded.

## What the model sees

With a key, each turn sends the system prompt, a context snapshot (open tasks, today's events, drifting people, goals, learned sentences, top memories) and the conversation history to Anthropic. Memories you delete stop being sent. Nothing is sent when no key is configured.

## Reporting

Open an issue with the label `security`, or contact the maintainers privately if the repository lists a contact.
