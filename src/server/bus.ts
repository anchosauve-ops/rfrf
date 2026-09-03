import { EventEmitter } from "node:events";

export type BusEvent =
  | { type: "nudge"; nudgeId: string }
  | { type: "mutation"; entity: string }
  | { type: "ritual"; ritualId: string }
  | { type: "focus"; state: "started" | "ended" };

/** In-process event bus: scheduler → SSE → every open tab. */
export class Bus extends EventEmitter {
  publish(e: BusEvent): void {
    this.emit("event", e);
  }
  subscribe(fn: (e: BusEvent) => void): () => void {
    this.on("event", fn);
    return () => this.off("event", fn);
  }
}
