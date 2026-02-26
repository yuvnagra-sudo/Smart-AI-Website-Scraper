/**
 * Batch Processor for Large-Scale Enrichment Jobs
 * Handles chunking, retry logic, and progress persistence
 */

import { updateEnrichmentJob, getEnrichmentJob } from "./enrichmentDb";

export interface BatchConfig {
  batchSize: number;
  progressUpdateInterval: number; // Update DB every N firms
  retryAttempts: number;
  retryDelay: number; // milliseconds
}

export const DEFAULT_BATCH_CONFIG: BatchConfig = {
  batchSize: 500, // Process 500 firms per batch to avoid memory issues
  progressUpdateInterval: 10, // Update DB every 10 firms to reduce load
  retryAttempts: 3,
  retryDelay: 2000,
};

/**
 * Process items in batches with progress tracking and retry logic
 */
export async function processBatches<TInput, TOutput>(
  items: TInput[],
  processor: (item: TInput) => Promise<TOutput>,
  config: BatchConfig,
  callbacks: {
    onBatchStart?: (batchIndex: number, batchSize: number) => void;
    onItemComplete?: (item: TInput, result: TOutput, index: number) => void;
    onItemError?: (item: TInput, error: any, index: number) => void;
    onProgressUpdate?: (processed: number, total: number) => Promise<void>;
    onBatchComplete?: (batchIndex: number, results: TOutput[]) => void;
  }
): Promise<TOutput[]> {
  const allResults: TOutput[] = [];
  let processedCount = 0;
  let lastProgressUpdate = 0;

  // Split into batches
  const batches: TInput[][] = [];
  for (let i = 0; i < items.length; i += config.batchSize) {
    batches.push(items.slice(i, i + config.batchSize));
  }

  console.log(`[Batch Processor] Processing ${items.length} items in ${batches.length} batches of ${config.batchSize}`);

  // Process each batch sequentially (to avoid overwhelming memory/DB)
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    
    if (callbacks.onBatchStart) {
      callbacks.onBatchStart(batchIndex, batch.length);
    }

    console.log(`[Batch Processor] Starting batch ${batchIndex + 1}/${batches.length} (${batch.length} items)`);

    // Process items in this batch in parallel (but batch is sequential)
    const batchResults = await Promise.allSettled(
      batch.map(async (item, itemIndex) => {
        const globalIndex = batchIndex * config.batchSize + itemIndex;
        return await processWithRetry(item, processor, config, globalIndex);
      })
    );

    // Collect results and handle errors
    const batchOutputs: TOutput[] = [];
    for (let i = 0; i < batchResults.length; i++) {
      const result = batchResults[i];
      const item = batch[i];
      const globalIndex = batchIndex * config.batchSize + i;
      
      processedCount++;

      if (result.status === "fulfilled" && result.value !== null) {
        batchOutputs.push(result.value);
        allResults.push(result.value);
        
        if (callbacks.onItemComplete) {
          callbacks.onItemComplete(item, result.value, globalIndex);
        }
      } else {
        const error = result.status === "rejected" ? result.reason : "Item returned null";
        console.error(`[Batch Processor] Error processing item ${globalIndex}:`, error);
        
        if (callbacks.onItemError) {
          callbacks.onItemError(item, error, globalIndex);
        }
      }

      // Update progress periodically (not every item)
      if (processedCount - lastProgressUpdate >= config.progressUpdateInterval) {
        if (callbacks.onProgressUpdate) {
          await callbacks.onProgressUpdate(processedCount, items.length);
        }
        lastProgressUpdate = processedCount;
      }
    }

    if (callbacks.onBatchComplete) {
      callbacks.onBatchComplete(batchIndex, batchOutputs);
    }

    console.log(`[Batch Processor] Completed batch ${batchIndex + 1}/${batches.length} (${batchOutputs.length}/${batch.length} successful)`);
  }

  // Final progress update
  if (callbacks.onProgressUpdate && processedCount !== lastProgressUpdate) {
    await callbacks.onProgressUpdate(processedCount, items.length);
  }

  console.log(`[Batch Processor] Completed all batches: ${allResults.length}/${items.length} successful`);

  return allResults;
}

/**
 * Process a single item with retry logic
 */
async function processWithRetry<TInput, TOutput>(
  item: TInput,
  processor: (item: TInput) => Promise<TOutput>,
  config: BatchConfig,
  index: number
): Promise<TOutput | null> {
  let lastError: any;

  for (let attempt = 1; attempt <= config.retryAttempts; attempt++) {
    try {
      return await processor(item);
    } catch (error) {
      lastError = error;
      console.error(`[Batch Processor] Attempt ${attempt}/${config.retryAttempts} failed for item ${index}:`, error);

      if (attempt < config.retryAttempts) {
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, config.retryDelay * attempt));
      }
    }
  }

  // All retries failed
  console.error(`[Batch Processor] All ${config.retryAttempts} attempts failed for item ${index}`);
  return null;
}

/**
 * Job resumption helper - finds last completed firm index
 */
export async function getJobResumePoint(jobId: number): Promise<number> {
  const job = await getEnrichmentJob(jobId);
  if (!job) return 0;
  
  // Resume from last processed count
  return job.processedCount || 0;
}

/**
 * Database-safe progress updater with connection retry
 */
export async function updateJobProgressSafely(
  jobId: number,
  updates: {
    processedCount?: number;
    currentFirmName?: string | null;
    currentTeamMemberCount?: number | null;
    activeFirmsJson?: string | null;
  },
  maxRetries: number = 3
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await updateEnrichmentJob(jobId, updates);
      return true;
    } catch (error: any) {
      console.error(`[DB Update] Attempt ${attempt}/${maxRetries} failed:`, error.message);
      
      // Check if it's a connection error
      if (error.message?.includes("ECONNRESET") || error.message?.includes("Connection")) {
        if (attempt < maxRetries) {
          // Wait and retry with exponential backoff
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
          continue;
        }
      }
      
      // Non-connection error or max retries reached
      console.error(`[DB Update] Failed to update job ${jobId} after ${maxRetries} attempts`);
      return false;
    }
  }
  
  return false;
}

/**
 * Memory-efficient batch iterator
 */
export async function* batchIterator<T>(
  items: T[],
  batchSize: number
): AsyncGenerator<T[], void, unknown> {
  for (let i = 0; i < items.length; i += batchSize) {
    yield items.slice(i, i + batchSize);
  }
}
