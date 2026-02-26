import { boolean, decimal, int, mysqlEnum, mysqlTable, text, timestamp, unique, varchar, index } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * Enrichment jobs table - tracks user upload and processing status
 */
export const enrichmentJobs = mysqlTable("enrichmentJobs", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  status: mysqlEnum("status", ["pending", "processing", "completed", "failed"]).default("pending").notNull(),
  inputFileUrl: text("inputFileUrl").notNull(),
  inputFileKey: text("inputFileKey").notNull(),
  outputFileUrl: text("outputFileUrl"),
  outputFileKey: text("outputFileKey"),
  firmCount: int("firmCount").default(0),
  processedCount: int("processedCount").default(0),
  tierFilter: mysqlEnum("tierFilter", ["tier1", "tier1-2", "all"]).default("all").notNull(),
  deepTeamProfileScraping: boolean("deepTeamProfileScraping").default(false).notNull(),
  maxTeamProfiles: int("maxTeamProfiles").default(200).notNull(),
  currentFirmName: text("currentFirmName"),
  currentTeamMemberCount: int("currentTeamMemberCount").default(0),
  activeFirmsJson: text("activeFirmsJson"), // JSON array of firm names currently being processed in parallel
  // Template and cost tracking
  template: varchar("template", { length: 50 }).default("vc"),
  estimatedCostUSD: decimal("estimatedCostUSD", { precision: 10, scale: 4 }),
  totalCostUSD: decimal("totalCostUSD", { precision: 10, scale: 4 }).default("0"),
  totalInputTokens: int("totalInputTokens").default(0),
  totalOutputTokens: int("totalOutputTokens").default(0),
  errorMessage: text("errorMessage"),
  // Worker tracking fields
  workerPid: int("workerPid"), // Process ID of worker processing this job
  heartbeatAt: timestamp("heartbeatAt"), // Last heartbeat from worker
  startedAt: timestamp("startedAt"), // When processing actually started
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  completedAt: timestamp("completedAt"),
});

export type EnrichmentJob = typeof enrichmentJobs.$inferSelect;
export type InsertEnrichmentJob = typeof enrichmentJobs.$inferInsert;
/**
 * Enriched VC firm data - stores processed results
 */
export const enrichedFirms = mysqlTable("enrichedFirms", {
  id: int("id").autoincrement().primaryKey(),
  jobId: int("jobId").notNull(),
  companyName: text("companyName").notNull(),
  websiteUrl: text("websiteUrl"),
  description: text("description"),
  websiteVerified: varchar("websiteVerified", { length: 10 }),
  verificationMessage: text("verificationMessage"),
  investorType: text("investorType"),
  investorTypeConfidence: int("investorTypeConfidence"),
  investorTypeSourceUrl: text("investorTypeSourceUrl"),
  investmentStages: text("investmentStages"),
  investmentStagesConfidence: int("investmentStagesConfidence"),
  investmentStagesSourceUrl: text("investmentStagesSourceUrl"),
  investmentNiches: text("investmentNiches"),
  nichesConfidence: int("nichesConfidence"),
  nichesSourceUrl: text("nichesSourceUrl"),
  // NEW: Structured firm-level investment mandate fields
  investmentThesis: text("investmentThesis"), // Investment philosophy/mandate
  aum: text("aum"), // Assets under management (e.g., "$90B")
  sectorFocus: text("sectorFocus"), // Detailed sector list (JSON array as string)
  geographicFocus: text("geographicFocus"), // Geographic preferences (JSON array as string)
  foundedYear: text("foundedYear"), // Year founded
  headquarters: text("headquarters"), // HQ location
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type EnrichedFirm = typeof enrichedFirms.$inferSelect;
export type InsertEnrichedFirm = typeof enrichedFirms.$inferInsert;

/**
 * Team members extracted from VC firms
 */
export const teamMembers = mysqlTable("teamMembers", {
  id: int("id").autoincrement().primaryKey(),
  jobId: int("jobId").notNull(),
  firmId: int("firmId").notNull(), // References enrichedFirms.id
  vcFirm: varchar("vcFirm", { length: 255 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  title: text("title"),
  jobFunction: text("jobFunction"),
  specialization: text("specialization"),
  linkedinUrl: text("linkedinUrl"),
  email: text("email"),
  portfolioCompanies: text("portfolioCompanies"), // Comma-separated list of portfolio companies associated with this team member
  // Individual investment mandate fields
  investmentFocus: text("investmentFocus"), // Specific sectors/areas they invest in
  stagePreference: text("stagePreference"), // Investment stages (Seed, Series A, Growth, etc.)
  checkSizeRange: text("checkSizeRange"), // Typical check size ($500K-$5M, etc.)
  geographicFocus: text("geographicFocus"), // Geographic preferences (US, Europe, Global, etc.)
  investmentThesis: text("investmentThesis"), // Personal investment philosophy
  notableInvestments: text("notableInvestments"), // Key investments/board seats (comma-separated)
  yearsExperience: text("yearsExperience"), // Years in VC/investing
  background: text("background"), // Professional background before VC
  dataSourceUrl: text("dataSourceUrl"),
  confidenceScore: int("confidenceScore"),
  decisionMakerTier: varchar("decisionMakerTier", { length: 20 }),
  tierPriority: int("tierPriority"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
// Note: Unique constraint removed - deduplication handled in-memory before insert

export type TeamMember = typeof teamMembers.$inferSelect;
export type InsertTeamMember = typeof teamMembers.$inferInsert;

/**
 * Portfolio companies extracted from VC firms
 */
export const portfolioCompanies = mysqlTable("portfolioCompanies", {
  id: int("id").autoincrement().primaryKey(),
  jobId: int("jobId").notNull(),
  firmId: int("firmId").notNull(), // References enrichedFirms.id
  vcFirm: text("vcFirm").notNull(),
  portfolioCompany: text("portfolioCompany").notNull(),
  investmentDate: text("investmentDate"),
  websiteUrl: text("websiteUrl"),
  investmentNiche: text("investmentNiche"),
  dataSourceUrl: text("dataSourceUrl"),
  confidenceScore: text("confidenceScore"),
  recencyScore: int("recencyScore"),
  recencyCategory: text("recencyCategory"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type PortfolioCompany = typeof portfolioCompanies.$inferSelect;
export type InsertPortfolioCompany = typeof portfolioCompanies.$inferInsert;

/**
 * Investment thesis generated for each VC firm
 */
export const investmentThesis = mysqlTable("investmentThesis", {
  id: int("id").autoincrement().primaryKey(),
  jobId: int("jobId").notNull(),
  firmId: int("firmId").notNull(), // References enrichedFirms.id
  vcFirm: text("vcFirm").notNull(),
  websiteUrl: text("websiteUrl"),
  investorType: text("investorType"),
  primaryFocusAreas: text("primaryFocusAreas"),
  emergingInterests: text("emergingInterests"),
  preferredStages: text("preferredStages"),
  averageCheckSize: text("averageCheckSize"),
  recentInvestmentPace: text("recentInvestmentPace"),
  keyDecisionMakers: text("keyDecisionMakers"),
  totalTeamSize: int("totalTeamSize"),
  tier1Count: int("tier1Count"),
  tier2Count: int("tier2Count"),
  portfolioSize: int("portfolioSize"),
  recentPortfolioCount: int("recentPortfolioCount"),
  talkingPoints: text("talkingPoints"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type InvestmentThesis = typeof investmentThesis.$inferSelect;
export type InsertInvestmentThesis = typeof investmentThesis.$inferInsert;

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
