import { eq } from "drizzle-orm";
import { enrichmentJobs, type InsertEnrichmentJob, type EnrichmentJob } from "../drizzle/schema";
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

export async function updateEnrichmentJob(id: number, updates: Partial<EnrichmentJob>): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db.update(enrichmentJobs).set(updates).where(eq(enrichmentJobs.id, id));
}
