/**
 * Secrets at rest. The API key lives in SQLite, encrypted with AES-256-GCM.
 * The key material comes from KAIROS_SECRET when set, otherwise from a
 * random secret generated once and stored next to the database with 0600
 * permissions. Losing that file means re-entering the API key; nothing else.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

let cachedKey: Buffer | undefined;

export function secretKey(dbPath: string): Buffer {
  if (cachedKey) return cachedKey;
  let material = process.env.KAIROS_SECRET;
  if (!material) {
    if (dbPath === ":memory:") material = randomBytes(32).toString("hex");
    else {
      const file = join(dirname(dbPath), ".kairos-secret");
      if (existsSync(file)) material = readFileSync(file, "utf8").trim();
      else {
        mkdirSync(dirname(file), { recursive: true });
        material = randomBytes(32).toString("hex");
        writeFileSync(file, material + "\n", { mode: 0o600 });
        try { chmodSync(file, 0o600); } catch { /* windows */ }
      }
    }
  }
  cachedKey = scryptSync(material, "kairos.v1", 32);
  return cachedKey;
}

export function seal(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function open(sealed: string, key: Buffer): string | undefined {
  if (!sealed.startsWith("enc:v1:")) return sealed; // legacy plaintext; re-sealed on next write
  const [, , ivB, tagB, dataB] = sealed.split(":");
  if (!ivB || !tagB || !dataB) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB, "base64"));
    decipher.setAuthTag(Buffer.from(tagB, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(dataB, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

export function resetSecretCache(): void {
  cachedKey = undefined;
}
