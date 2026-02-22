/**
 * Job Resumption Helper
 * Allows restarting failed jobs from where they left off
 */

import { getEnrichmentJob, updateEnrichmentJob } from "./enrichmentDb";

/**
 * Check if a job can be resumed
 */
export async function canResumeJob(jobId: number): Promise<{
  canResume: boolean;
  reason?: string;
  processedCount: number;
  totalCount: number;
}> {
  const job = await getEnrichmentJob(jobId);
  
  if (!job) {
    return {
      canResume: false,
      reason: "Job not found",
      processedCount: 0,
      totalCount: 0,
    };
  }
  
  if (job.status === "completed") {
    return {
      canResume: false,
      reason: "Job already completed",
      processedCount: job.processedCount || 0,
      totalCount: job.firmCount || 0,
    };
  }
  
  if (job.status === "processing") {
    return {
      canResume: false,
      reason: "Job is currently processing",
      processedCount: job.processedCount || 0,
      totalCount: job.firmCount || 0,
    };
  }
  
  const processedCount = job.processedCount || 0;
  const totalCount = job.firmCount || 0;
  
  if (processedCount >= totalCount) {
    return {
      canResume: false,
      reason: "All firms already processed",
      processedCount,
      totalCount,
    };
  }
  
  return {
    canResume: true,
    processedCount,
    totalCount,
  };
}

/**
 * Reset job to allow resumption
 */
export async function prepareJobForResume(jobId: number): Promise<void> {
  await updateEnrichmentJob(jobId, {
    status: "pending",
    errorMessage: null,
  });
}

/**
 * Get resume progress information
 */
export async function getResumeProgress(jobId: number): Promise<{
  firmCount: number;
  processedCount: number;
  remainingCount: number;
  percentComplete: number;
}> {
  const job = await getEnrichmentJob(jobId);
  
  if (!job) {
    return {
      firmCount: 0,
      processedCount: 0,
      remainingCount: 0,
      percentComplete: 0,
    };
  }
  
  const firmCount = job.firmCount || 0;
  const processedCount = job.processedCount || 0;
  const remainingCount = Math.max(0, firmCount - processedCount);
  const percentComplete = firmCount > 0 ? Math.round((processedCount / firmCount) * 100) : 0;
  
  return {
    firmCount,
    processedCount,
    remainingCount,
    percentComplete,
  };
}
