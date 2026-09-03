import type { SVGProps } from "react";
const P = (props: SVGProps<SVGSVGElement>) => ({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, ...props });
export const I = {
  now: (p: SVGProps<SVGSVGElement>) => <svg {...P(p)}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>,
  day: (p: SVGProps<SVGSVGElement>) => <svg {...P(p)}><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>,
  tasks: (p: SVGProps<SVGSVGElement>) => <svg {...P(p)}><path d="M4 7l2 2 4-4M4 13l2 2 4-4M4 19l2 2 4-4M13 7h7M13 13h7M13 19h7" /></svg>,
  memory: (p: SVGProps<SVGSVGElement>) => <svg {...P(p)}><path d="M9 3a4 4 0 0 0-4 4v1a3 3 0 0 0-1 5.5V15a4 4 0 0 0 4 4h1M15 3a4 4 0 0 1 4 4v1a3 3 0 0 1 1 5.5V15a4 4 0 0 1-4 4h-1M12 3v18" /></svg>,
  people: (p: SVGProps<SVGSVGElement>) => <svg {...P(p)}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4.5-6.2" /></svg>,
  rituals: (p: SVGProps<SVGSVGElement>) => <svg {...P(p)}><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4" /><circle cx="12" cy="12" r="4" /></svg>,
  settings: (p: SVGProps<SVGSVGElement>) => <svg {...P(p)}><path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="8" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></svg>,
  send: (p: SVGProps<SVGSVGElement>) => <svg {...P(p)}><path d="M5 12h14M13 6l6 6-6 6" /></svg>,
  mic: (p: SVGProps<SVGSVGElement>) => <svg {...P(p)}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>,
  check: (p: SVGProps<SVGSVGElement>) => <svg {...P({ ...p, strokeWidth: 2.4 })}><path d="M5 12l4 4 10-10" /></svg>,
  x: (p: SVGProps<SVGSVGElement>) => <svg {...P(p)}><path d="M6 6l12 12M18 6L6 18" /></svg>,
  left: (p: SVGProps<SVGSVGElement>) => <svg {...P(p)}><path d="M15 6l-6 6 6 6" /></svg>,
  right: (p: SVGProps<SVGSVGElement>) => <svg {...P(p)}><path d="M9 6l6 6-6 6" /></svg>,
  refresh: (p: SVGProps<SVGSVGElement>) => <svg {...P(p)}><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" /></svg>,
  pin: (p: SVGProps<SVGSVGElement>) => <svg {...P(p)}><path d="M12 17v5M8 3h8l-1 7 3 3H6l3-3z" /></svg>,
  play: (p: SVGProps<SVGSVGElement>) => <svg {...P(p)}><path d="M7 5v14l12-7z" /></svg>,
  spark: (p: SVGProps<SVGSVGElement>) => <svg {...P(p)}><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" /></svg>,
  chevron: (p: SVGProps<SVGSVGElement>) => <svg {...P(p)}><path d="M6 9l6 6 6-6" /></svg>,
  trash: (p: SVGProps<SVGSVGElement>) => <svg {...P(p)}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>,
};
