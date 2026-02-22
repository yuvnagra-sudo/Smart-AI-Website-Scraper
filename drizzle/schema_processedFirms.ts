import { mysqlTable, int, text, timestamp, mysqlEnum, index } from "drizzle-orm/mysql-core";

/**
 * ProcessedFirms table - tracks which firms have been successfully processed
 * Enables job resumption and prevents data loss on crashes
 */
export const processedFirms = mysqlTable("processedFirms", {
  id: int("id").autoincrement().primaryKey(),
  jobId: int("jobId").notNull(),
  firmName: text("firmName").notNull(),
  firmUrl: text("firmUrl"),
  status: mysqlEnum("status", ["processing", "completed", "failed"]).default("processing").notNull(),
  teamMembersFound: int("teamMembersFound").default(0),
  errorMessage: text("errorMessage"),
  processedAt: timestamp("processedAt").defaultNow().notNull(),
  completedAt: timestamp("completedAt"),
}, (table) => ({
  jobIdIdx: index("jobId_idx").on(table.jobId),
  jobIdFirmNameIdx: index("jobId_firmName_idx").on(table.jobId, table.firmName),
}));

export type ProcessedFirm = typeof processedFirms.$inferSelect;
export type InsertProcessedFirm = typeof processedFirms.$inferInsert;
