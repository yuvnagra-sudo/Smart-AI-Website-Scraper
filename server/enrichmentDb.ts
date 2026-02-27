import { eq, sql } from "drizzle-orm";
import { enrichmentJobs, jobLogs, type InsertEnrichmentJob, type EnrichmentJob, type InsertJobLog, type JobLog } from "../drizzle/schema";
import { getDb } from "./db";

export async function createEnrichmentJob(job: InsertEnrichmentJob): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db.insert(enrichmentJobs).values(job);
  return Number(result[0].insertId);
}

export async function getEnrichmentJob(id: number): Promise<EnrichmentJob | undefined> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db.select().from(enrichmentJobs).where(eq(enrichmentJobs.id, id)).limit(1);
  return result[0];
}

export async function getUserEnrichmentJobs(userId: number): Promise<EnrichmentJob[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return await db.select().from(enrichmentJobs).where(eq(enrichmentJobs.userId, userId)).orderBy(enrichmentJobs.createdAt);
}

export async function incrementJobProcessedCount(jobId: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(enrichmentJobs)
    .set({ processedCount: sql`${enrichmentJobs.processedCount} + 1` })
    .where(eq(enrichmentJobs.id, jobId));
}

export async function getAllEnrichmentJobs(): Promise<EnrichmentJob[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return await db.select().from(enrichmentJobs).orderBy(enrichmentJobs.createdAt);
}

export async function updateEnrichmentJob(id: number, updates: Partial<EnrichmentJob>): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db.update(enrichmentJobs).set(updates).where(eq(enrichmentJobs.id, id));
}

export async function insertJobLog(log: InsertJobLog): Promise<void> {
  const db = await getDb();
  if (!db) return; // non-fatal — don't block processing if DB unavailable
  await db.insert(jobLogs).values(log);
}

export async function getJobLogs(jobId: number, limit = 500): Promise<JobLog[]> {
  const db = await getDb();
  if (!db) return [];
  return await db.select().from(jobLogs)
    .where(eq(jobLogs.jobId, jobId))
    .orderBy(jobLogs.createdAt)
    .limit(limit);
}
