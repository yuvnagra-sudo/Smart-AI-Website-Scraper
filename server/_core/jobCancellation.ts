/**
 * In-memory cancellation flags for running jobs.
 *
 * The worker heartbeat (every 30s) checks the DB for "cancelled" status
 * and calls markJobCancelled(). Processing loops check isJobCancelled()
 * at the start of each firm to break out early.
 */

const cancelledJobs = new Set<number>();

export function markJobCancelled(jobId: number): void {
  cancelledJobs.add(jobId);
}

export function isJobCancelled(jobId: number): boolean {
  return cancelledJobs.has(jobId);
}

export function clearJobCancelled(jobId: number): void {
  cancelledJobs.delete(jobId);
}
