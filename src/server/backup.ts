/**
 * Backups — a JSON snapshot of everything, daily, kept for a while.
 * Local-first software owes people a way back.
 */
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Repo } from "./repo.js";

export interface BackupOptions {
  dbPath: string;
  keep?: number; // files to keep
  dir?: string;
}

export function backupDir(dbPath: string, dir?: string): string {
  return dir ?? join(dirname(dbPath), "backups");
}

export function writeBackup(repo: Repo, opts: BackupOptions, now = new Date()): string | undefined {
  if (opts.dbPath === ":memory:" && !opts.dir) return undefined;
  const dir = backupDir(opts.dbPath, opts.dir);
  mkdirSync(dir, { recursive: true });
  const name = `kairos-${now.toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(repo.exportAll()), { mode: 0o600 });
  prune(dir, opts.keep ?? 14);
  return path;
}

export function prune(dir: string, keep: number): void {
  if (!existsSync(dir)) return;
  const files = readdirSync(dir)
    .filter((f) => f.startsWith("kairos-") && f.endsWith(".json"))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of files.slice(keep)) unlinkSync(join(dir, f));
}

export function lastBackupAt(dir: string): Date | undefined {
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir).filter((f) => f.startsWith("kairos-") && f.endsWith(".json"));
  if (!files.length) return undefined;
  return new Date(Math.max(...files.map((f) => statSync(join(dir, f)).mtimeMs)));
}
