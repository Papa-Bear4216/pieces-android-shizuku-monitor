import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { seedToPiecesOS } from "./seeder.js";

// Durable store for telemetry that failed to seed into PiecesOS (e.g. it was
// restarting or unreachable) — separate from USAGE_LOG_PATH, which is a
// permanent audit trail and never drained. This file only holds items still
// awaiting a successful seed; entries are removed once seedToPiecesOS
// succeeds so it doesn't grow without bound while PiecesOS is up.
type PendingSeed = { bodyText: string; title: string; queuedAt: string; attempts: number };

const RETRY_INTERVAL_MS = 30_000;
const MAX_ATTEMPTS = 50; // ~25 minutes of retrying before giving up on an item

export class SeedQueue {
  private readonly queuePath: string;
  private readonly piecesBaseUrl: string;
  private draining = false;

  constructor(queuePath: string, piecesBaseUrl: string) {
    this.queuePath = queuePath;
    this.piecesBaseUrl = piecesBaseUrl;
  }

  /** Append one failed seed attempt to the durable queue. */
  async enqueue(bodyText: string, title: string): Promise<void> {
    await mkdir(dirname(this.queuePath), { recursive: true });
    const entry: PendingSeed = { bodyText, title, queuedAt: new Date().toISOString(), attempts: 0 };
    await appendFile(this.queuePath, JSON.stringify(entry) + "\n", "utf-8");
  }

  private async readAll(): Promise<PendingSeed[]> {
    try {
      const raw = await readFile(this.queuePath, "utf-8");
      return raw
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as PendingSeed);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  private async writeAll(entries: PendingSeed[]): Promise<void> {
    // Write to a temp file and rename over the original — avoids a reader
    // (or a crash mid-write) ever seeing a partially-written queue file.
    const tmpPath = `${this.queuePath}.tmp`;
    await mkdir(dirname(this.queuePath), { recursive: true });
    if (entries.length === 0) {
      await writeFile(tmpPath, "", "utf-8");
    } else {
      await writeFile(tmpPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
    }
    await rename(tmpPath, this.queuePath);
  }

  /** Try to seed every pending entry; keep only the ones that still fail. */
  async drain(): Promise<{ succeeded: number; remaining: number; dropped: number }> {
    if (this.draining) return { succeeded: 0, remaining: 0, dropped: 0 };
    this.draining = true;
    try {
      const entries = await this.readAll();
      if (entries.length === 0) return { succeeded: 0, remaining: 0, dropped: 0 };

      const stillPending: PendingSeed[] = [];
      let succeeded = 0;
      let dropped = 0;

      for (const entry of entries) {
        try {
          await seedToPiecesOS(this.piecesBaseUrl, entry.bodyText, entry.title);
          succeeded++;
        } catch {
          const attempts = entry.attempts + 1;
          if (attempts >= MAX_ATTEMPTS) {
            // Giving up avoids an unbounded queue if PiecesOS is gone for
            // good (uninstalled, moved) — the original data is still safe
            // in USAGE_LOG_PATH, just not auto-reconciled into PiecesOS.
            dropped++;
            continue;
          }
          stillPending.push({ ...entry, attempts });
        }
      }

      await this.writeAll(stillPending);
      return { succeeded, remaining: stillPending.length, dropped };
    } finally {
      this.draining = false;
    }
  }

  /** Start a background timer that periodically retries pending seeds. */
  startRetryLoop(): void {
    setInterval(() => {
      this.drain()
        .then(({ succeeded, remaining, dropped }) => {
          if (succeeded > 0 || dropped > 0) {
            console.log(
              `[seed-queue] drain: ${succeeded} succeeded, ${remaining} still pending${dropped > 0 ? `, ${dropped} dropped after ${MAX_ATTEMPTS} attempts` : ""}`,
            );
          }
        })
        .catch((err) => console.warn("[seed-queue] drain failed", err));
    }, RETRY_INTERVAL_MS);
  }
}
