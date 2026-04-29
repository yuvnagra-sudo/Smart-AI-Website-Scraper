/**
 * Persistent Background Worker for VC Enrichment Jobs
 * 
 * This worker:
 * - Polls the database for pending jobs
 * - Processes one job at a time
 * - Sends heartbeats to detect crashes
 * - Automatically recovers stale jobs
 * - Resumes from last checkpoint on restart
 * - Runs continuously until stopped
 */

import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import { enrichmentJobs } from '../drizzle/schema';
import { eq, and, or, lt, isNull } from 'drizzle-orm';
import { processAgentJob } from './routers';
import { markJobCancelled, clearJobCancelled, markJobPaused, clearJobPaused } from './_core/jobCancellation';
import { updateEnrichmentJob } from './enrichmentDb';
import {
  DEFAULT_AGENT_SECTIONS,
  DEFAULT_AGENT_SYSTEM_PROMPT,
  DEFAULT_AGENT_OBJECTIVE,
} from './_core/defaultAgentConfig';

// Prevent unhandled promise rejections from crashing the worker process.
// puppeteer-extra-plugin-stealth fires internal events that can reject outside
// any try/catch (e.g. "Requesting main frame too early!", "Session closed").
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  // Suppress known noisy Puppeteer/stealth errors
  if (/main frame too early|Session closed|Target closed|Protocol error/i.test(msg)) {
    console.warn(`[Worker] Suppressed unhandled rejection: ${msg.slice(0, 120)}`);
    return;
  }
  console.error("[Worker] Unhandled rejection:", reason);
});

const POLL_INTERVAL = 5000; // Check for new jobs every 5 seconds
const HEARTBEAT_INTERVAL = 30000; // Send heartbeat every 30 seconds
const STALE_THRESHOLD = 5 * 60 * 1000; // 5 minutes without heartbeat = stale
const CANCEL_CHECK_INTERVAL = 5000; // Poll DB for cancellation every 5 seconds

let currentJobId: number | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let cancellationTimer: NodeJS.Timeout | null = null;
let isShuttingDown = false;

/**
 * Get database connection with retry logic
 */
async function getDb(retries = 3) {
  // Retry logic for connection
  for (let i = 0; i < retries; i++) {
    try {
      const conn = await mysql.createConnection({
        uri: process.env.DATABASE_URL!,
        enableKeepAlive: true,
        keepAliveInitialDelay: 0,
      });
      // Test connection
      await conn.ping();
      return drizzle(conn);
    } catch (error) {
      console.error(`[Worker] Database connection attempt ${i + 1}/${retries} failed:`, error);
      if (i === retries - 1) throw error;
      // Exponential backoff: 2s, 4s, 8s
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, i + 1) * 1000));
    }
  }
  
  throw new Error('Failed to connect to database after retries');
}

/**
 * Find next pending job or recover stale jobs
 */
async function findNextJob() {
  const db = await getDb();
  
  // First, check for stale jobs (processing but no recent heartbeat)
  const staleThreshold = new Date(Date.now() - STALE_THRESHOLD);
  const staleJobs = await db.select()
    .from(enrichmentJobs)
    .where(
      and(
        eq(enrichmentJobs.status, "processing"),
        or(
          lt(enrichmentJobs.heartbeatAt!, staleThreshold),
          isNull(enrichmentJobs.heartbeatAt)
        )
      )
    )
    .limit(1);
  
  if (staleJobs.length > 0) {
    const job = staleJobs[0];
    console.log(`[Worker] Found stale job ${job.id} (last heartbeat: ${job.heartbeatAt})`);
    console.log(`[Worker] Resetting job ${job.id} to pending for recovery`);

    // Clear any in-memory cancellation flag from a previous run
    clearJobCancelled(job.id);
    clearJobPaused(job.id);

    // Reset to pending so it can be picked up
    await db.update(enrichmentJobs)
      .set({ 
        status: "pending",
        workerPid: null,
        heartbeatAt: null 
      })
      .where(eq(enrichmentJobs.id, job.id));
    
    return job;
  }
  
  // Find next pending job
  const pendingJobs = await db.select()
    .from(enrichmentJobs)
    .where(eq(enrichmentJobs.status, "pending"))
    .orderBy(enrichmentJobs.createdAt)
    .limit(1);
  
  return pendingJobs.length > 0 ? pendingJobs[0] : null;
}

/**
 * Claim a job for processing
 */
async function claimJob(jobId: number): Promise<boolean> {
  const db = await getDb();
  
  try {
    // Atomically claim the job — only succeeds if job is still "pending"
    const result = await db.update(enrichmentJobs)
      .set({
        status: "processing",
        workerPid: process.pid,
        heartbeatAt: new Date(),
        startedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(enrichmentJobs.id, jobId),
          eq(enrichmentJobs.status, "pending")
        )
      );

    // MySQL returns [ResultSetHeader, ...] — affectedRows tells us if the update matched
    const affectedRows = (result as any)[0]?.affectedRows ?? 0;
    if (affectedRows === 0) {
      console.log(`[Worker] Job ${jobId} was already claimed by another process, skipping`);
      return false;
    }
    return true;
  } catch (error) {
    console.error(`[Worker] Failed to claim job ${jobId}:`, error);
    return false;
  }
}

/**
 * Send heartbeat to indicate worker is alive
 */
async function sendHeartbeat(jobId: number) {
  const db = await getDb();
  
  try {
    await db.update(enrichmentJobs)
      .set({ heartbeatAt: new Date() })
      .where(eq(enrichmentJobs.id, jobId));
  } catch (error) {
    console.error(`[Worker] Failed to send heartbeat for job ${jobId}:`, error);
  }
}

/**
 * Start heartbeat timer for current job
 */
function startHeartbeat(jobId: number) {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }
  
  heartbeatTimer = setInterval(() => {
    if (!isShuttingDown) {
      sendHeartbeat(jobId);
    }
  }, HEARTBEAT_INTERVAL);
}

/**
 * Stop heartbeat timer
 */
function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/**
 * Start polling the DB for cancellation/pause requests.
 * When the web server sets status="cancelled" or "paused", this timer detects
 * it and sets the in-memory flag so processAgentJob/scrapeUrl can abort promptly.
 */
function startCancellationPoller(jobId: number) {
  if (cancellationTimer) clearInterval(cancellationTimer);
  cancellationTimer = setInterval(async () => {
    if (isShuttingDown) return;
    try {
      const db = await getDb();
      const rows = await db.select({ status: enrichmentJobs.status })
        .from(enrichmentJobs)
        .where(eq(enrichmentJobs.id, jobId))
        .limit(1);
      if (rows[0]?.status === 'cancelled') {
        console.log(`[Worker] Detected cancellation for job ${jobId} — flagging in-process`);
        markJobCancelled(jobId);
        clearInterval(cancellationTimer!);
        cancellationTimer = null;
      } else if (rows[0]?.status === 'paused') {
        console.log(`[Worker] Detected pause for job ${jobId} — flagging in-process`);
        markJobPaused(jobId);
        clearInterval(cancellationTimer!);
        cancellationTimer = null;
      }
    } catch {
      // Non-fatal: next tick will retry
    }
  }, CANCEL_CHECK_INTERVAL);
}

/**
 * Stop the cancellation poller
 */
function stopCancellationPoller() {
  if (cancellationTimer) {
    clearInterval(cancellationTimer);
    cancellationTimer = null;
  }
}

/**
 * Process a single job
 */
async function processJob(job: any) {
  currentJobId = job.id;
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[Worker] Starting job ${job.id}`);
  console.log(`[Worker] Firms: ${job.processedCount}/${job.firmCount}`);
  console.log(`[Worker] Created: ${job.createdAt}`);
  if (job.processedCount > 0) {
    console.log(`[Worker] Resuming from firm ${job.processedCount + 1}`);
  }
  console.log(`${'='.repeat(60)}\n`);
  
  // Start sending heartbeats and cancellation poller
  startHeartbeat(job.id);
  startCancellationPoller(job.id);

  try {
    // All jobs flow through the generic agent pipeline. If a job arrived without
    // sectionsJson (legacy VC jobs, direct DB inserts, future API callers), hydrate
    // it with the b2b defaults so the agent pipeline has something to extract.
    if (!job.sectionsJson) {
      console.log(`[Worker] Job ${job.id} has no sectionsJson — hydrating with default b2b agent config`);
      await updateEnrichmentJob(job.id, {
        sectionsJson: JSON.stringify(DEFAULT_AGENT_SECTIONS),
        systemPrompt: job.systemPrompt || DEFAULT_AGENT_SYSTEM_PROMPT,
        objective: job.objective || DEFAULT_AGENT_OBJECTIVE,
      });
    }
    await processAgentJob(job.id);

    console.log(`\n[Worker] ✅ Job ${job.id} completed successfully!`);
  } catch (error: any) {
    const isCancelledError = error?.message === 'JOB_CANCELLED';
    if (isCancelledError) {
      console.log(`\n[Worker] 🛑 Job ${job.id} was cancelled by user — stopping cleanly`);
      // Status is already "cancelled" in DB (set by cancelJob mutation)
    } else {
      console.error(`\n[Worker] ❌ Job ${job.id} failed:`, error);

      // Update job status to failed
      const db = await getDb();
      await db.update(enrichmentJobs)
        .set({
          status: "failed",
          errorMessage: error instanceof Error ? error.message : String(error),
          completedAt: new Date(),
        })
        .where(eq(enrichmentJobs.id, job.id));
    }
  } finally {
    // Stop heartbeat and cancellation poller, clean up in-memory flags
    stopHeartbeat();
    stopCancellationPoller();
    clearJobCancelled(job.id);
    clearJobPaused(job.id);
    currentJobId = null;
  }
}

/**
 * Main worker loop
 */
async function workerLoop() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[Worker] VC Enrichment Background Worker Started`);
  console.log(`[Worker] PID: ${process.pid}`);
  console.log(`[Worker] Poll interval: ${POLL_INTERVAL}ms`);
  console.log(`[Worker] Heartbeat interval: ${HEARTBEAT_INTERVAL}ms`);
  console.log(`[Worker] Stale threshold: ${STALE_THRESHOLD}ms`);
  console.log(`${'='.repeat(60)}\n`);
  
  while (!isShuttingDown) {
    try {
      // Find next job
      console.log('[Worker] Polling for jobs...');
      const job = await findNextJob();
      console.log(`[Worker] Found job:`, job ? `Job ${job.id}` : 'None');
      
      if (job) {
        // Claim the job
        const claimed = await claimJob(job.id);
        
        if (claimed) {
          // Process the job
          await processJob(job);
        } else {
          console.log(`[Worker] Failed to claim job ${job.id}, skipping`);
        }
      } else {
        // No jobs available, wait before checking again
        console.log(`[Worker] No jobs found, waiting ${POLL_INTERVAL}ms...`);
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
      }
    } catch (error) {
      console.error('[Worker] Error in worker loop:', error);
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
    }
  }
  
  console.log('\n[Worker] Shutting down gracefully...');
}

/**
 * Handle graceful shutdown
 */
function setupShutdownHandlers() {
  const shutdown = async (signal: string) => {
    console.log(`\n[Worker] Received ${signal}, shutting down...`);
    isShuttingDown = true;
    
    // Stop heartbeat
    stopHeartbeat();
    
    // If processing a job, mark it as pending so it can be resumed
    if (currentJobId) {
      console.log(`[Worker] Releasing job ${currentJobId} for resume`);
      const db = await getDb();
      await db.update(enrichmentJobs)
        .set({
          status: "pending",
          workerPid: null,
          heartbeatAt: null,
        })
        .where(eq(enrichmentJobs.id, currentJobId));
    }
    
    console.log('[Worker] Shutdown complete');
    process.exit(0);
  };
  
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/**
 * Start the worker
 */
async function main() {
  setupShutdownHandlers();
  
  try {
    await workerLoop();
  } catch (error) {
    console.error('[Worker] Fatal error:', error);
    process.exit(1);
  }
}

// Start the worker
main().catch((error) => {
  console.error('[Worker] Failed to start:', error);
  process.exit(1);
});
