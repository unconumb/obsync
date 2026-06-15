/**
 * AiInferenceQueue — serial in-memory job queue for AI inference (AI-07).
 *
 * AI-07: AI inference is queued — one job at a time, never concurrent — to
 *        avoid laptop stress during heavy editing sessions.
 * D-40: Designed to be instantiated once and reused by both `obsync sync`
 *       (one-shot batch of all AI-eligible files after the copy loop) and
 *       `obsync watch` (jobs trickle in as files change and are appended to
 *       the same queue).
 *
 * Error isolation: a job whose run() rejects does not stop subsequent jobs —
 * each job owns its own audit logging (per-file isolation, SYNC-06-equivalent);
 * the queue itself never throws.
 */

/** AiJob — a unit of work enqueued for serial processing. */
export interface AiJob {
  run: () => Promise<void>;
}

/** Polling interval used by drain() while waiting for the queue to empty. */
const DRAIN_POLL_MS = 50;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * AiInferenceQueue — FIFO queue that processes one job at a time.
 *
 * Usage: enqueue jobs as they become available, then `await drain()` to wait
 * for all currently-enqueued (and any subsequently-enqueued) jobs to finish.
 */
export class AiInferenceQueue {
  private queue: AiJob[] = [];
  private processing = false;

  /** Number of jobs currently queued (read-only; D-03). */
  get size(): number {
    return this.queue.length;
  }

  /** Add a job to the end of the queue and kick off processing if idle. */
  enqueue(job: AiJob): void {
    this.queue.push(job);
    void this.process();
  }

  /**
   * Resolve once the queue is empty and no job is currently processing.
   * Polls on a short interval since processing happens in the background
   * via enqueue()'s fire-and-forget process() call.
   */
  async drain(): Promise<void> {
    while (this.processing || this.queue.length > 0) {
      await delay(DRAIN_POLL_MS);
    }
  }

  /**
   * Process queued jobs one at a time, in FIFO order. Errors from an
   * individual job are swallowed — the queue never throws and subsequent
   * jobs continue to run (error isolation).
   */
  private async process(): Promise<void> {
    if (this.processing) {
      return;
    }
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift();
        if (!job) {
          continue;
        }
        try {
          await job.run();
        } catch {
          // Per-file isolation: job.run() owns its own audit/error logging.
          // The queue never throws and continues with the next job.
        }
      }
    } finally {
      this.processing = false;
    }
  }
}
