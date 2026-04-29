/**
 * Shared types for the agent scraper pipeline (used by superScraper, excelProcessor,
 * routers, and the various dataSources). Originally defined inside agentScraper.ts
 * — moved out so that file could be deleted.
 */

export interface AgentSection {
  key: string;
  label: string;
  desc: string;
}

export interface DirectoryEntry {
  name: string;
  directoryUrl: string;
  nativeUrl?: string;
}

export interface ScrapeStats {
  fieldsTotal: number;
  fieldsFilled: number;
  emptyFields: string[];
  // Scraper-app-style counters for the stats grid
  emailCount?: number;   // Number of distinct email addresses found
  personCount?: number;  // Number of named people/contacts found
  hasData?: boolean;     // True if at least one field was filled
}

/** Diagnostic data collected during scraping — used for the Debug sheet in output Excel. */
export interface ScrapeDiagnostics {
  pagesCollected: number;
  pageUrls: string[];
  pageSizes: number[];           // char count per page
  phase2FieldsFilled: number;
  phase3FieldsFilled: number;
  phase4FieldsFilled: number;
  phase5FieldsFilled: number;
  failedUrls: string[];
  softDeleted: string[];         // soft-404 URLs
  topPagePreview: string;        // first 500 chars of best-scoring page
  failures?: string[];           // non-fatal extraction failures for visibility
  // All employees found across all sources (website, Hunter, Vayne, Serper)
  allEmployees?: Array<{
    name: string;
    title: string;
    email: string;
    linkedinUrl: string;
    source: string;
    selected?: boolean;
  }>;
}

export type AgentScrapeResult =
  | { type: "directory"; entries: DirectoryEntry[] }
  | { type: "profile"; data: Record<string, string>; stats: ScrapeStats; diagnostics?: ScrapeDiagnostics };
