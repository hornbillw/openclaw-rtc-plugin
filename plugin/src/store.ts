import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RtcCallRecord } from "./types.js";

/**
 * JSONL-based call record store.
 * Appends each state change as a new line to a `.jsonl` file.
 */
export class RtcCallStore {
  private filePath: string;

  constructor(stateDir: string) {
    const dir = join(stateDir, "webrtc");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.filePath = join(dir, "calls.jsonl");
  }

  /**
   * Append a call record snapshot to the store.
   */
  append(record: RtcCallRecord): void {
    const line = JSON.stringify({
      ...record,
      _ts: Date.now(),
    });
    appendFileSync(this.filePath, line + "\n", "utf8");
  }

  /**
   * Read all stored records (for recovery/status display).
   * Returns the latest snapshot per callId.
   */
  readAll(): RtcCallRecord[] {
    if (!existsSync(this.filePath)) return [];

    const content = readFileSync(this.filePath, "utf8").trim();
    if (!content) return [];

    const latest = new Map<string, RtcCallRecord>();
    for (const line of content.split("\n")) {
      try {
        const record = JSON.parse(line) as RtcCallRecord & { _ts?: number };
        delete (record as Record<string, unknown>)._ts;
        latest.set(record.callId, record);
      } catch {
        // skip malformed lines
      }
    }
    return [...latest.values()];
  }

  /**
   * Read recent calls (last N).
   */
  readRecent(limit: number = 20): RtcCallRecord[] {
    const all = this.readAll();
    return all
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
      .slice(0, limit);
  }
}
