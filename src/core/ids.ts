const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function randomChunk(len: number): string {
  let out = "";
  const g: { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } } = globalThis as never;
  if (g.crypto?.getRandomValues) {
    const bytes = new Uint8Array(len);
    g.crypto.getRandomValues(bytes);
    for (let i = 0; i < len; i++) out += ALPHABET[(bytes[i] ?? 0) % ALPHABET.length];
    return out;
  }
  for (let i = 0; i < len; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return out;
}

/** Short, sortable-ish, URL-safe id: `<prefix>_<time36><rand>` */
export function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomChunk(8)}`;
}
