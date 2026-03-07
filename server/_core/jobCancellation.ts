/**
 * In-process job cancellation registry.
 *
 * The web server and worker run as separate Node.js processes inside the same
 * Railway container. This module provides a lightweight in-memory Set that the
 * worker process uses to track which jobs have been cancelled.
 *
 * Flow:
 *  1. User clicks Cancel → cancelJob mutation writes status="cancelled" to DB.
 *  2. Worker's checkForCancellation timer (every 5s) reads the DB and calls
 *     markJobCancelled(jobId) to set the in-memory flag.
 *  3. processAgentJob / scrapeUrl call isCancelled(jobId) before each unit of
 *     work (per-firm, per-hop, per-fetch) and abort early when true.
 *
 * Note: Because each process has its own copy of this module, the web server's
 * cancelJob mutation must NOT call markJobCancelled() — only the worker should.
 * The web server only writes to the DB; the worker reads from it.
 */

const cancelledJobs = new Set<number>();

/**
 * Returns true if the given job has been flagged for cancellation in this process.
 */
export function isJobCancelled(jobId: number): boolean {
  return cancelledJobs.has(jobId);
}

/**
 * Mark a job as cancelled in this process's in-memory registry.
 * Should only be called by the worker process after detecting DB status = "cancelled".
 */
export function markJobCancelled(jobId: number): void {
  cancelledJobs.add(jobId);
}

/**
 * Remove a job from the cancellation registry (call after the job has fully stopped).
 */
export function clearJobCancelled(jobId: number): void {
  cancelledJobs.delete(jobId);
}
