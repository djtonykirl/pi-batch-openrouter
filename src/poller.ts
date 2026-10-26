import type { BatchService, ReconcileOutcome } from "./service.js";
import type { JobManifest } from "./types.js";
import { ACTIVE_STATUSES } from "./state.js";

export type BadgeCallback = (badgeText: string | undefined) => void;

/** How often the scheduler wakes to look for due jobs; each job's own nextPollAt decides whether it is polled. */
const TICK_MS = 15_000;

/**
 * In-session scheduler. Non-blocking: work runs on timers, never inside a
 * command handler unless the user asked (`/batch check`). Jobs are reconciled
 * sequentially to keep provider traffic low; per-job file locks prevent
 * overlap with other Pi processes on the same project.
 */
export class BatchPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<ReconcileOutcome[]> | null = null;
  private stopped = true;

  constructor(
    private readonly getService: () => BatchService | null,
    private readonly isEnabled: () => boolean,
    private readonly onBadge?: BadgeCallback,
    /** Runs after every pass (chat housekeeping). Errors are swallowed so scheduling never stops. */
    private readonly onTick?: () => Promise<void>,
  ) {}

  public start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  public stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.isEnabled()) {
        this.updateBadge();
        this.schedule(TICK_MS);
        return;
      }
      void this.checkNow(false).finally(() => this.schedule(TICK_MS));
    }, delayMs);
    // Never keep Pi alive just for polling.
    (this.timer as { unref?: () => void }).unref?.();
  }

  /**
   * Reconcile jobs. `force` ignores nextPollAt (used by /batch check).
   * Concurrent calls share or follow the in-flight pass instead of overlapping.
   */
  public async checkNow(force = true): Promise<ReconcileOutcome[]> {
    if (this.running) {
      const current = await this.running;
      if (!force) return current;
    }
    const pass = this.runPass(force);
    this.running = pass;
    try {
      return await pass;
    } finally {
      if (this.running === pass) this.running = null;
      this.updateBadge();
    }
  }

  private async runPass(force: boolean): Promise<ReconcileOutcome[]> {
    const service = this.getService();
    if (!service) return [];
    const outcomes: ReconcileOutcome[] = [];
    for (const job of service.jobsNeedingReconcile()) {
      try {
        outcomes.push(await service.reconcile(job.localId, { force }));
      } catch (err) {
        // A bug or corrupt manifest for one job must not stop the others; it stays visible via /batch list.
        outcomes.push({ localId: job.localId, status: job.localStatus, polled: false, error: (err as Error).message });
      }
    }
    try {
      await this.onTick?.();
    } catch {
      // The tick owner logs its own failures; polling must carry on.
    }
    return outcomes;
  }

  public updateBadge(): void {
    const service = this.getService();
    if (!service) return this.onBadge?.(undefined);
    let jobs: JobManifest[];
    try {
      jobs = service.registry.list().jobs;
    } catch {
      return this.onBadge?.(undefined);
    }
    this.onBadge?.(badgeText(jobs));
  }
}

/** e.g. "📦 Batch: 2 active | 1 partial | 3 ready" — only non-zero parts, cleared when nothing to show. No costs. */
export function badgeText(jobs: readonly JobManifest[]): string | undefined {
  const active = jobs.filter((j) => ACTIVE_STATUSES.has(j.localStatus)).length;
  const partial = jobs.filter((j) => j.localStatus === "partial" && !j.injectedAt).length;
  const ready = jobs.filter((j) => j.localStatus === "ready" && !j.injectedAt).length;
  const attention = jobs.filter((j) => (j.localStatus === "corrupt" || (ACTIVE_STATUSES.has(j.localStatus) && j.lastPollError)) && !j.injectedAt).length;
  const parts: string[] = [];
  if (active) parts.push(`${active} active`);
  if (partial) parts.push(`${partial} partial`);
  if (ready) parts.push(`${ready} ready`);
  if (attention) parts.push(`${attention} attention`);
  return parts.length ? `📦 Batch: ${parts.join(" | ")}` : undefined;
}
