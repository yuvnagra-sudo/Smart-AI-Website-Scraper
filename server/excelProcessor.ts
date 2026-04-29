import * as XLSX from "xlsx";
import axios from "axios";
import { parse as csvParse } from "csv-parse/sync";

export interface VCFirmInput {
  companyName: string;
  websiteUrl: string;
  description: string;
}

export interface ColumnMapping {
  companyNameColumn?: string; // optional — falls back to URL if not provided
  websiteUrlColumn: string;
  descriptionColumn?: string;
}

export interface FileHeaders {
  columns: string[];
  sampleRows: Array<Record<string, string>>;
  autoDetected: {
    companyName?: string;
    websiteUrl?: string;
    description?: string;
  };
}

export interface EnrichedVCData {
  companyName: string;
  websiteUrl: string;
  description?: string; // Optional
  websiteVerified: string;
  verificationMessage: string;
  investorType: string;
  investorTypeConfidence: string;
  investorTypeSourceUrl: string;
  investmentStages: string;
  investmentStagesConfidence: string;
  investmentStagesSourceUrl: string;
  investmentNiches: string;
  nichesConfidence: string;
  nichesSourceUrl: string;
  // NEW: Structured firm-level investment mandate data
  firmData?: {
    investmentThesis?: string;
    aum?: string;
    investmentStages?: string[];
    sectorFocus?: string[];
    geographicFocus?: string[];
    foundedYear?: string;
    headquarters?: string;
  };
}

export interface TeamMemberData {
  vcFirm: string;
  name: string;
  title: string;
  jobFunction: string;
  specialization: string;
  linkedinUrl: string;
  email: string;
  portfolioCompanies: string; // Comma-separated list of portfolio companies associated with this team member
  // Individual investment mandate fields
  investmentFocus: string;
  stagePreference: string;
  checkSizeRange: string;
  geographicFocus: string;
  investmentThesis: string;
  notableInvestments: string;
  yearsExperience: string;
  background: string;
  dataSourceUrl: string;
  confidenceScore: string;
  decisionMakerTier: string;
  tierPriority: number;
  // AI fit scoring + buying committee
  fitScore?: number | null;
  fitReasoning?: string | null;
  buyingRole?: string | null;
}

export interface PortfolioCompanyData {
  vcFirm: string;
  portfolioCompany: string;
  investmentDate: string;
  websiteUrl: string;
  investmentNiche: string;
  dataSourceUrl: string;
  confidenceScore: string;
  recencyScore: number;
  recencyCategory: string;
}

// ---------------------------------------------------------------------------
// Shared: read file into row data
// ---------------------------------------------------------------------------

async function readFileToRows(fileUrl: string): Promise<any[]> {
  let buffer: Buffer;

  if (fileUrl.startsWith('/') || fileUrl.startsWith('./')) {
    const fs = await import('fs/promises');
    buffer = await fs.readFile(fileUrl);
  } else {
    const response = await axios.get(fileUrl, { responseType: "arraybuffer" });
    buffer = Buffer.from(response.data);
  }

  const isCsv = fileUrl.toLowerCase().endsWith('.csv');

  if (isCsv) {
    const text = buffer.toString('utf-8');
    return csvParse(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    }) as any[];
  } else {
    const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error("No sheets found in file");
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) throw new Error("Sheet not found");
    return XLSX.utils.sheet_to_json(sheet, { raw: false, defval: "" }) as any[];
  }
}

// Column name variants for auto-detection
const COMPANY_NAME_VARIANTS = [
  "Company Name", "company_name", "CompanyName", "company name",
  "Business Name", "business_name", "BusinessName", "business name",
  "Organization", "organization", "Org Name", "org_name",
  "Company", "company", "Name", "name", "Firm Name", "firm_name", "Firm", "firm",
  "Business", "business",
  // GoodFirms CSS class exports
  "provider__title-link", "provider__title",
];
const WEBSITE_URL_VARIANTS = [
  "Company Website URL", "website_url", "WebsiteURL", "Company Website",
  "company website url", "Corporate Website", "corporate website",
  "Corporate LinkedIn URL", "corporate linkedin url",
  "Website", "website", "URL", "url", "Site", "site",
  "Link", "link", "Web", "web", "Homepage", "homepage",
  // GoodFirms CSS class exports — "Visit Website" href is the company's own site;
  // logo href is the GoodFirms profile URL (scraper handles directory entries)
  "provider__cta-link href", "sg-provider-logotype-v2 href",
];
const DESCRIPTION_VARIANTS = [
  "LinkedIn Description", "linkedin_description", "Description", "description",
  "linkedin description", "About", "about", "Summary", "summary",
];

// Returns true if a string looks like a URL (not an email or plain text)
function looksLikeUrl(s: string): boolean {
  const t = s.trim();
  return t.startsWith("http://") || t.startsWith("https://") || t.startsWith("www.");
}

// Find websiteUrl column: prefer name-based match but validate with cell content.
// Falls back to any column whose sample values look like URLs.
function detectWebsiteUrlColumn(
  columns: string[],
  sampleRows: Record<string, string>[]
): string | undefined {
  const nameMatch = findMatchingColumnHeader(columns, WEBSITE_URL_VARIANTS);
  if (nameMatch) {
    const hasUrlContent = sampleRows.some(row => looksLikeUrl(row[nameMatch] ?? ""));
    if (hasUrlContent) return nameMatch; // name + content both match
  }
  // Fallback: find any column whose sample values look like URLs
  for (const col of columns) {
    if (sampleRows.some(row => looksLikeUrl(row[col] ?? ""))) return col;
  }
  return nameMatch; // give up — return name match so user can remap manually
}

// Find which column header matches a set of variants (returns the header name, not the value)
function findMatchingColumnHeader(columns: string[], possibleNames: string[]): string | undefined {
  for (const name of possibleNames) {
    const lowerName = name.toLowerCase().replace(/[\s_-]/g, '');
    for (const col of columns) {
      if (col === name) return col;
      if (col.toLowerCase() === name.toLowerCase()) return col;
      if (col.toLowerCase().replace(/[\s_-]/g, '') === lowerName) return col;
    }
  }
  return undefined;
}

// Find column value from a row using variant matching
function findColumnValue(row: any, possibleNames: string[]): string | undefined {
  for (const name of possibleNames) {
    if (row[name] !== undefined) return String(row[name]);
    const lowerName = name.toLowerCase();
    for (const key of Object.keys(row)) {
      if (key.toLowerCase() === lowerName || key.toLowerCase().replace(/[\s_-]/g, '') === lowerName.replace(/[\s_-]/g, '')) {
        return String(row[key]);
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Parse file headers + auto-detect columns (never throws on missing columns)
// ---------------------------------------------------------------------------

export async function parseInputHeaders(fileUrl: string): Promise<FileHeaders> {
  const data = await readFileToRows(fileUrl);
  if (data.length === 0) throw new Error("File is empty or has no data rows");

  const columns = Object.keys(data[0] || {});
  const sampleRows = data.slice(0, 5).map(row => {
    const clean: Record<string, string> = {};
    for (const col of columns) clean[col] = String(row[col] ?? "");
    return clean;
  });

  return {
    columns,
    sampleRows,
    autoDetected: {
      companyName: findMatchingColumnHeader(columns, COMPANY_NAME_VARIANTS),
      websiteUrl: detectWebsiteUrlColumn(columns, sampleRows),
      description: findMatchingColumnHeader(columns, DESCRIPTION_VARIANTS),
    },
  };
}

// ---------------------------------------------------------------------------
// Parse input file into firm list (with optional explicit column mapping)
// ---------------------------------------------------------------------------

export async function parseInputExcel(fileUrl: string, columnMapping?: ColumnMapping): Promise<VCFirmInput[]> {
  const data = await readFileToRows(fileUrl);

  if (data.length === 0) {
    throw new Error("File is empty or has no data rows");
  }

  const availableColumns = Object.keys(data[0] || {});
  const firms: VCFirmInput[] = [];
  const skippedRows: number[] = [];

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (!row) continue;

    let companyName: string | undefined;
    let websiteUrl: string | undefined;
    let description: string | undefined;

    if (columnMapping) {
      // Use explicit column mapping
      if (columnMapping.companyNameColumn) {
        companyName = row[columnMapping.companyNameColumn] != null ? String(row[columnMapping.companyNameColumn]) : undefined;
      }
      websiteUrl = row[columnMapping.websiteUrlColumn] != null ? String(row[columnMapping.websiteUrlColumn]) : undefined;
      description = columnMapping.descriptionColumn ? String(row[columnMapping.descriptionColumn] ?? "") : "";
    } else {
      // Auto-detect using variant matching
      companyName = findColumnValue(row, COMPANY_NAME_VARIANTS);
      websiteUrl = findColumnValue(row, WEBSITE_URL_VARIANTS);
      description = findColumnValue(row, DESCRIPTION_VARIANTS);
    }

    // Reject email addresses that ended up in the websiteUrl field
    if (websiteUrl && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(websiteUrl.trim()) && !websiteUrl.includes("://")) {
      console.log(`[Excel Parser] Skipping row ${i + 2}: websiteUrl is an email address (${websiteUrl})`);
      skippedRows.push(i + 2);
      continue;
    }

    if (!websiteUrl) {
      console.log(`[Excel Parser] Skipping row ${i + 2}: missing required websiteUrl`);
      skippedRows.push(i + 2);
      continue;
    }

    // Company name is optional — fall back to URL as identifier
    if (!companyName) companyName = websiteUrl;

    firms.push({
      companyName,
      websiteUrl,
      description: description || '',
    });
  }

  console.log(`[Excel Parser] Successfully parsed ${firms.length} firms, skipped ${skippedRows.length} rows`);

  if (firms.length === 0) {
    const columnList = availableColumns.join(", ");
    throw new Error(
      `No valid data found. Your file has columns: [${columnList}]. ` +
      `Required: a Website URL column (or Website/URL/Link). ` +
      `Company Name is optional (falls back to URL if not provided). ` +
      (skippedRows.length > 0 ? `Skipped rows: ${skippedRows.join(", ")}` : "")
    );
  }

  return firms;
}

import type { InvestmentThesisSummary } from "./investmentThesisAnalyzer";
import type { AgentSection, DirectoryEntry, ScrapeDiagnostics } from "./agentScraper";

export interface ProcessingSummaryData {
  firmName: string;
  website: string;
  status: string;
  errorMessage: string;
  teamMembersFound: number;
  tier1Count: number;
  tier2Count: number;
  tier3Count: number;
  portfolioCompaniesFound: number;
  dataCompleteness: string;
}

/**
 * Sanitize data to prevent NaN/undefined/null from corrupting Excel
 */
function sanitizeForExcel(data: any[]): any[] {
  return data.map(row => {
    const sanitized: any = {};
    for (const [key, value] of Object.entries(row)) {
      if (value === null || value === undefined || (typeof value === 'number' && isNaN(value))) {
        sanitized[key] = '';
      } else if (typeof value === 'string' && value.toLowerCase() === 'nan') {
        sanitized[key] = '';
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  });
}

export function createOutputExcel(
  firms: EnrichedVCData[],
  teamMembers: TeamMemberData[],
  portfolioCompanies: PortfolioCompanyData[],
  investmentThesisSummaries?: InvestmentThesisSummary[],
  processingSummary?: ProcessingSummaryData[],
): Buffer {
  // Create workbook
  const workbook = XLSX.utils.book_new();

   // Sanitize all data before export
  const sanitizedFirms = sanitizeForExcel(firms);
  const sanitizedTeamMembers = sanitizeForExcel(teamMembers);
  const sanitizedPortfolio = sanitizeForExcel(portfolioCompanies);
  
  // Sheet 1: VC Firms (handle empty array)
  const firmsSheet = sanitizedFirms.length > 0
    ? XLSX.utils.json_to_sheet(sanitizedFirms)
    : XLSX.utils.aoa_to_sheet([["No firms found"]]);
  XLSX.utils.book_append_sheet(workbook, firmsSheet, "VC Firms");

  // Sheet 2: Team Members (handle empty array)
  const teamSheet = sanitizedTeamMembers.length > 0
    ? XLSX.utils.json_to_sheet(sanitizedTeamMembers)
    : XLSX.utils.aoa_to_sheet([["No team members found"]]);
  XLSX.utils.book_append_sheet(workbook, teamSheet, "Team Members");

  // Sheet 3: Portfolio Companies (handle empty array)
  const portfolioSheet = sanitizedPortfolio.length > 0
    ? XLSX.utils.json_to_sheet(sanitizedPortfolio)
    : XLSX.utils.aoa_to_sheet([["No portfolio companies found"]]);
  XLSX.utils.book_append_sheet(workbook, portfolioSheet, "Portfolio Companies");

  // Sheet 4: Investment Thesis Summary (if provided)
  if (investmentThesisSummaries && investmentThesisSummaries.length > 0) {
    const summarySheet = XLSX.utils.json_to_sheet(investmentThesisSummaries);
    XLSX.utils.book_append_sheet(workbook, summarySheet, "Investment Thesis");
  }

  // Sheet 5: Processing Summary (if provided)
  if (processingSummary && processingSummary.length > 0) {
    const processingSummarySheet = XLSX.utils.json_to_sheet(processingSummary);
    XLSX.utils.book_append_sheet(workbook, processingSummarySheet, "Processing Summary");
  }

  // Write to buffer with proper options to prevent corruption
  const buffer = XLSX.write(workbook, {
    type: "buffer",
    bookType: "xlsx",
    compression: true, // Enable compression
    bookSST: false, // Disable shared string table for better compatibility
  });

  return buffer;
}

/**
 * Create output Excel for agentic extraction jobs.
 * - "Results" sheet: one row per profile entity, one column per custom section
 * - "Collected URLs" sheet: entries gathered from directory pages
 */
export function createAgentOutputExcel(
  sections: AgentSection[],
  profileResults: Array<Record<string, string>>,
  collectedUrls: DirectoryEntry[],
  diagnosticResults?: Array<{ companyName: string; websiteUrl: string; diagnostics: ScrapeDiagnostics }>,
): Buffer {
  const workbook = XLSX.utils.book_new();

  // Sheet 1: Results (profile extractions)
  if (profileResults.length > 0) {
    const rows = profileResults.map((r) => {
      const row: Record<string, string> = {
        "Company Name": r["Company Name"] ?? "",
        "Website": r["Website"] ?? "",
      };
      for (const s of sections) {
        row[s.label] = r[s.key] ?? "";
      }
      return row;
    });
    const sanitizedRows = sanitizeForExcel(rows);
    const sheet = XLSX.utils.json_to_sheet(sanitizedRows);
    XLSX.utils.book_append_sheet(workbook, sheet, "Results");
  } else {
    // Empty placeholder sheet
    const sheet = XLSX.utils.aoa_to_sheet([["No profile results found"]]);
    XLSX.utils.book_append_sheet(workbook, sheet, "Results");
  }

  // Sheet 2: Collected URLs (from directory pages)
  if (collectedUrls.length > 0) {
    const urlRows = collectedUrls.map((e) => ({
      "Company Name": e.name,
      "Directory URL": e.directoryUrl,
      "Native URL": e.nativeUrl ?? "",
    }));
    const sanitizedUrlRows = sanitizeForExcel(urlRows);
    const urlSheet = XLSX.utils.json_to_sheet(sanitizedUrlRows);
    XLSX.utils.book_append_sheet(workbook, urlSheet, "Collected URLs");
  }

  // Sheet 3: All Employees — every person found per company across all sources
  if (diagnosticResults && diagnosticResults.length > 0) {
    const employeeRows: Record<string, string>[] = [];
    for (const d of diagnosticResults) {
      const employees = (d.diagnostics as any).allEmployees as Array<{
        name: string; title: string; email: string; linkedinUrl: string; source: string; selected?: boolean;
      }> | undefined;
      if (!employees || employees.length === 0) continue;
      // Sort: selected first, then by source
      const sorted = [...employees].sort((a, b) => {
        if (a.selected && !b.selected) return -1;
        if (!a.selected && b.selected) return 1;
        return a.source.localeCompare(b.source);
      });
      for (const emp of sorted) {
        employeeRows.push({
          "Company": d.companyName,
          "Website": d.websiteUrl,
          "Selected": emp.selected ? "✓" : "",
          "Name": emp.name,
          "Title": emp.title,
          "Email": emp.email,
          "LinkedIn URL": emp.linkedinUrl,
          "Source": emp.source,
        });
      }
    }
    if (employeeRows.length > 0) {
      const sanitized = sanitizeForExcel(employeeRows);
      const sheet = XLSX.utils.json_to_sheet(sanitized);
      XLSX.utils.book_append_sheet(workbook, sheet, "All Employees");
    }
  }

  // Sheet 4: Diagnostics — raw scrape data per company for debugging
  if (diagnosticResults && diagnosticResults.length > 0) {
    const diagRows = diagnosticResults.map((d) => {
      const diag = d.diagnostics as any; // extended diagnostics may have extra fields
      return {
        "Company": d.companyName,
        "Website": d.websiteUrl,
        "Pages Collected": d.diagnostics.pagesCollected,
        "Page URLs": d.diagnostics.pageUrls.join("\n"),
        "Page Sizes (chars)": d.diagnostics.pageSizes.join(", "),
        "Phase 2 Fields Filled": d.diagnostics.phase2FieldsFilled,
        "Phase 3 Fields Filled": d.diagnostics.phase3FieldsFilled,
        "Phase 4 Fields Filled": d.diagnostics.phase4FieldsFilled,
        "Phase 5 Fields Filled": d.diagnostics.phase5FieldsFilled,
        "Failed URLs": d.diagnostics.failedUrls.join("\n") || "(none)",
        "Soft-404 URLs": d.diagnostics.softDeleted.join("\n") || "(none)",
        "Hunter Contacts": Array.isArray(diag.hunterContacts) ? diag.hunterContacts.join("\n") : "(none)",
        "Hunter Re-Eval": diag.hunterReEval || "(not run)",
        "Failures": Array.isArray(diag.failures) && diag.failures.length > 0 ? diag.failures.join("\n") : "(none)",
        "Top Page Preview": d.diagnostics.topPagePreview,
      };
    });
    const sanitizedDiagRows = sanitizeForExcel(diagRows);
    const diagSheet = XLSX.utils.json_to_sheet(sanitizedDiagRows);
    XLSX.utils.book_append_sheet(workbook, diagSheet, "Diagnostics");
  }

  return XLSX.write(workbook, {
    type: "buffer",
    bookType: "xlsx",
    compression: true,
    bookSST: false,
  });
}
