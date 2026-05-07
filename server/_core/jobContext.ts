/**
 * Job-scoped context using AsyncLocalStorage.
 *
 * Worker wraps the entire job execution in jobContext.run(...). Any helper
 * deep in the call stack — LLM calls, Jina fetches, Hunter/Apollo API calls —
 * can read getJobSignal() to find the AbortSignal for the running job without
 * needing it threaded through every function signature.
 *
 * When the user clicks Cancel, the worker calls abortJob(jobId) which fires
 * the signal — every in-flight fetch / LLM call sees it and aborts.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface JobContext {
  jobId: number;
  signal: AbortSignal;
}

export const jobContext = new AsyncLocalStorage<JobContext>();

/** Get the current job's AbortSignal, or undefined if not running inside a job. */
export function getJobSignal(): AbortSignal | undefined {
  return jobContext.getStore()?.signal;
}

/** Get the current job's id, or undefined if not running inside a job. */
export function getJobId(): number | undefined {
  return jobContext.getStore()?.jobId;
}

/**
 * Combine the current job's signal (if any) with an additional signal
 * (typically `AbortSignal.timeout(N)` for per-request timeouts). Returns
 * a single AbortSignal that aborts when either fires.
 */
export function withJobSignal(extra?: AbortSignal): AbortSignal | undefined {
  const job = getJobSignal();
  if (!job && !extra) return undefined;
  if (!job) return extra;
  if (!extra) return job;
  // AbortSignal.any is available in Node 20.3+ (we target Node 22).
  return AbortSignal.any([job, extra]);
}
