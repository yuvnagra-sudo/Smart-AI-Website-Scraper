import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertUser, users } from "../drizzle/schema";

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

// TODO: add feature queries here as your schema grows.

/**
 * Run schema migrations for new columns.
 * MySQL doesn't support ADD COLUMN IF NOT EXISTS, so we catch duplicate-column errors.
 */
export async function runMigrations(): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const migrations = [
    { name: "activeFirmsJson",    sql: "ALTER TABLE enrichmentJobs ADD COLUMN activeFirmsJson TEXT" },
    { name: "template",           sql: "ALTER TABLE enrichmentJobs ADD COLUMN template VARCHAR(50) DEFAULT 'vc'" },
    { name: "estimatedCostUSD",   sql: "ALTER TABLE enrichmentJobs ADD COLUMN estimatedCostUSD DECIMAL(10,4)" },
    { name: "estimatedCostLow",   sql: "ALTER TABLE enrichmentJobs ADD COLUMN estimatedCostLow DECIMAL(10,4)" },
    { name: "estimatedCostHigh",  sql: "ALTER TABLE enrichmentJobs ADD COLUMN estimatedCostHigh DECIMAL(10,4)" },
    { name: "totalCostUSD",       sql: "ALTER TABLE enrichmentJobs ADD COLUMN totalCostUSD DECIMAL(10,4) DEFAULT 0" },
    { name: "totalInputTokens",   sql: "ALTER TABLE enrichmentJobs ADD COLUMN totalInputTokens INT DEFAULT 0" },
    { name: "totalOutputTokens",  sql: "ALTER TABLE enrichmentJobs ADD COLUMN totalOutputTokens INT DEFAULT 0" },
    // Agentic extraction columns
    { name: "sectionsJson",       sql: "ALTER TABLE enrichmentJobs ADD COLUMN sectionsJson TEXT" },
    { name: "systemPrompt",       sql: "ALTER TABLE enrichmentJobs ADD COLUMN systemPrompt TEXT" },
    { name: "objective",          sql: "ALTER TABLE enrichmentJobs ADD COLUMN objective TEXT" },
    { name: "columnMappingJson",  sql: "ALTER TABLE enrichmentJobs ADD COLUMN columnMappingJson TEXT" },
    // Skill context + worker tracking
    { name: "skillContextJson",   sql: "ALTER TABLE enrichmentJobs ADD COLUMN skillContextJson TEXT" },
    { name: "workerPid",          sql: "ALTER TABLE enrichmentJobs ADD COLUMN workerPid INT" },
    { name: "heartbeatAt",        sql: "ALTER TABLE enrichmentJobs ADD COLUMN heartbeatAt TIMESTAMP NULL" },
    { name: "startedAt",          sql: "ALTER TABLE enrichmentJobs ADD COLUMN startedAt TIMESTAMP NULL" },
    { name: "currentFirmName",    sql: "ALTER TABLE enrichmentJobs ADD COLUMN currentFirmName TEXT" },
    { name: "currentTeamMemberCount", sql: "ALTER TABLE enrichmentJobs ADD COLUMN currentTeamMemberCount INT DEFAULT 0" },
    { name: "errorMessage",       sql: "ALTER TABLE enrichmentJobs ADD COLUMN errorMessage TEXT" },
    { name: "completedAt",        sql: "ALTER TABLE enrichmentJobs ADD COLUMN completedAt TIMESTAMP NULL" },
    // Per-URL workflow tracking table
    { name: "jobLogs_table", sql: `CREATE TABLE IF NOT EXISTS jobLogs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      jobId INT NOT NULL,
      url TEXT,
      companyName TEXT,
      status VARCHAR(20) NOT NULL,
      fieldsTotal INT,
      fieldsFilled INT,
      emptyFields TEXT,
      errorReason TEXT,
      errorDetail TEXT,
      durationMs INT,
      createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
      INDEX jobLogs_jobId_idx (jobId)
    )` },
  ];

  // Use the raw mysql2 pool for DDL. drizzle's db.execute() wraps queries
  // in prepared statements, which silently fail for ALTER TABLE in MySQL.
  const pool = (db as any).$client;

  for (const migration of migrations) {
    try {
      await pool.query(migration.sql);
      console.log(`[Migration] Applied: ${migration.name}`);
    } catch (e: any) {
      if (e.message?.includes("Duplicate column name") || e.message?.includes("already exists")) {
        // Column/table already exists — skip silently
      } else {
        console.error(`[Migration] Failed (${migration.name}):`, e.message);
      }
    }
  }
}
