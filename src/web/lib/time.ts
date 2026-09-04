export function fmtTime(iso: string | Date, tz?: string): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(iso));
}
export function fmtDay(iso: string | Date, tz?: string, opts: Intl.DateTimeFormatOptions = {}): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: tz, ...opts }).format(new Date(iso));
}
export function fmtLong(iso: string | Date, tz?: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: tz }).format(new Date(iso));
}
export function relDay(iso: string, now: Date, tz?: string): string {
  const k = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const target = new Date(iso);
  const today = k(now);
  const t = k(target);
  if (t === today) return "today";
  const tomorrow = k(new Date(now.getTime() + 86400_000));
  if (t === tomorrow) return "tomorrow";
  const yesterday = k(new Date(now.getTime() - 86400_000));
  if (t === yesterday) return "yesterday";
  const days = Math.round((new Date(t).getTime() - new Date(today).getTime()) / 86400_000);
  if (days > 0 && days < 7) return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: tz }).format(target);
  return fmtDay(target, tz);
}
export function dueLabel(iso: string, now: Date, tz?: string): { text: string; overdue: boolean } {
  const d = new Date(iso);
  const overdue = d < now;
  const when = `${relDay(iso, now, tz)} ${fmtTime(d, tz)}`;
  return { text: overdue ? `was due ${when}` : `due ${when}`, overdue };
}
export function minutes(n: number): string {
  if (n < 60) return `${n}m`;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
export function dayKeyLocal(d: Date, tz?: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
export function minuteOfDay(d: Date, tz?: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}
export function pad(n: number): string {
  return String(n).padStart(2, "0");
}
export function minToHHMM(min: number): string {
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}
export function hhmmToMin(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}
