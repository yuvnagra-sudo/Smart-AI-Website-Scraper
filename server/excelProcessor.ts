import * as XLSX from "xlsx";
import axios from "axios";
import { parse as csvParse } from "csv-parse/sync";

// ---------------------------------------------------------------------------
// URL normalization helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a URL to a canonical form:
 * - Trim whitespace
 * - Prepend https:// if missing
 * - Strip trailing slashes
 */
export function normalizeUrl(raw: string): string {
  let u = raw.trim();
  if (!u) return u;
  if (!u.startsWith("http://") && !u.startsWith("https://")) {
    u = "https://" + u;
  }
  u = u.replace(/\/+$/, "");
  return u;
}

/**
 * Derive a human-readable company name from a URL hostname.
 * e.g. "https://sequoiacap.com" -> "Sequoiacap"
 *      "https://www.acme-corp.com" -> "Acme Corp"
 */
export function deriveCompanyName(url: string): string {
  try {
    const hostname = new URL(url).hostname
      .replace(/^www\./, "")
      .split(".")[0]
      .replace(/[-_]/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2");
    return hostname
      .split(" ")
      .filter(Boolean)
      .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  } catch {
    return url;
  }
}

export interface InputQualityReport {
  valid: number;
  duplicatesRemoved: number;
  malformedUrls: number;
  missingCompanyNames: number;
}

export interface VCFirmInput {
  companyName: string;
  websiteUrl: string;
  description: string;
  originalRow: Record<string, string>; // all raw columns from the input file
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
  // Google Maps / local business exports
  "Website URL", "website url", "Business Website", "business website",
  "Business URL", "business url", "Place URL", "place url",
  "Maps URL", "maps url", "Google Maps URL", "google maps url",
  "Profile URL", "profile url", "Listing URL", "listing url",
  // Hunter / ZoomInfo / LinkedIn Sales Nav exports
  "Company Domain", "company domain", "Domain", "domain",
  "Company URL", "company url", "Org URL", "org url",
  "LinkedIn URL", "linkedin url", "LinkedIn", "linkedin",
  // GoodFirms CSS class exports — "Visit Website" href is the company's own site;
  // logo href is the GoodFirms profile URL (scraper handles directory entries)
  "provider__cta-link href", "sg-provider-logotype-v2 href",
];
const DESCRIPTION_VARIANTS = [
  "LinkedIn Description", "linkedin_description", "Description", "description",
  "linkedin description", "About", "about", "Summary", "summary",
];

// Returns true if a string looks like a URL or domain (not an email or plain text)
function looksLikeUrl(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (t.startsWith("http://") || t.startsWith("https://") || t.startsWith("www.")) return true;
  // Match bare domains like "example.com" or "sub.example.co.uk"
  // Must have a dot and a valid TLD (2-6 chars), no spaces
  if (!t.includes(' ') && /^[a-zA-Z0-9-]+\.[a-zA-Z]{2,6}(\.[a-zA-Z]{2,6})?(\/.*)?$/.test(t)) return true;
  return false;
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

export async function parseInputExcel(
  fileUrl: string,
  columnMapping?: ColumnMapping,
): Promise<VCFirmInput[] & { qualityReport: InputQualityReport }> {
  const data = await readFileToRows(fileUrl);

  if (data.length === 0) {
    throw new Error("File is empty or has no data rows");
  }

  const availableColumns = Object.keys(data[0] || {});
  const rawFirms: VCFirmInput[] = [];
  const skippedRows: number[] = [];
  let malformedUrls = 0;
  let missingCompanyNames = 0;

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (!row) continue;

    let companyName: string | undefined;
    let websiteUrl: string | undefined;
    let description: string | undefined;

    if (columnMapping) {
      if (columnMapping.companyNameColumn) {
        companyName = row[columnMapping.companyNameColumn] != null
          ? String(row[columnMapping.companyNameColumn]).trim() : undefined;
      }
      websiteUrl = row[columnMapping.websiteUrlColumn] != null
        ? String(row[columnMapping.websiteUrlColumn]).trim() : undefined;
      description = columnMapping.descriptionColumn
        ? String(row[columnMapping.descriptionColumn] ?? "") : "";
    } else {
      companyName = findColumnValue(row, COMPANY_NAME_VARIANTS);
      websiteUrl = findColumnValue(row, WEBSITE_URL_VARIANTS);
      description = findColumnValue(row, DESCRIPTION_VARIANTS);
    }

    // Reject email addresses that ended up in the websiteUrl field
    if (websiteUrl && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(websiteUrl.trim()) && !websiteUrl.includes("://")) {
      console.log(`[Excel Parser] Skipping row ${i + 2}: websiteUrl is an email address (${websiteUrl})`);
      skippedRows.push(i + 2);
      malformedUrls++;
      continue;
    }

    if (!websiteUrl || !websiteUrl.trim()) {
      console.log(`[Excel Parser] Skipping row ${i + 2}: missing required websiteUrl`);
      skippedRows.push(i + 2);
      continue;
    }

    // Normalize URL: add protocol, strip trailing slashes
    const normalizedUrl = normalizeUrl(websiteUrl);

    // Validate the normalized URL is parseable
    try {
      new URL(normalizedUrl);
    } catch {
      console.log(`[Excel Parser] Skipping row ${i + 2}: malformed URL (${websiteUrl})`);
      skippedRows.push(i + 2);
      malformedUrls++;
      continue;
    }

    // Track missing company names before fallback
    if (!companyName || !companyName.trim()) {
      missingCompanyNames++;
      // Derive a clean display name from the hostname instead of using raw URL string
      companyName = deriveCompanyName(normalizedUrl);
    }

    const originalRow: Record<string, string> = {};
    for (const col of availableColumns) originalRow[col] = String(row[col] ?? "");

    rawFirms.push({
      companyName,
      websiteUrl: normalizedUrl,
      description: description || '',
      originalRow,
    });
  }

  // Deduplicate by normalized URL (keep first occurrence)
  const seenUrls = new Set<string>();
  const firms: VCFirmInput[] = [];
  let duplicatesRemoved = 0;
  for (const firm of rawFirms) {
    if (seenUrls.has(firm.websiteUrl)) {
      duplicatesRemoved++;
      console.log(`[Excel Parser] Deduplicating: ${firm.websiteUrl}`);
    } else {
      seenUrls.add(firm.websiteUrl);
      firms.push(firm);
    }
  }

  const qualityReport: InputQualityReport = {
    valid: firms.length,
    duplicatesRemoved,
    malformedUrls,
    missingCompanyNames,
  };

  console.log(
    `[Excel Parser] Parsed ${firms.length} firms, skipped ${skippedRows.length} rows, ` +
    `removed ${duplicatesRemoved} duplicates, ${malformedUrls} malformed URLs`,
  );

  if (firms.length === 0) {
    const columnList = availableColumns.join(", ");
    const allRows = data.slice(0, 5);
    const urlLikeCols = availableColumns.filter(col =>
      allRows.some(row => looksLikeUrl(String(row[col] ?? "")))
    );
    const suggestion = urlLikeCols.length > 0
      ? ` Columns that look like they contain URLs: [${urlLikeCols.join(", ")}]. Use the column mapping tool to assign one as "Website URL".`
      : ` No columns with URL-like values were detected. Please add a Website URL column to your file.`;
    throw new Error(
      `No valid data found. Your file has columns: [${columnList}].${suggestion}` +
      (skippedRows.length > 0 ? ` Skipped rows: ${skippedRows.join(", ")}` : "")
    );
  }

  // Attach quality report as a non-enumerable property so it doesn't break existing array callers
  Object.defineProperty(firms, 'qualityReport', { value: qualityReport, enumerable: false, writable: false });
  return firms as VCFirmInput[] & { qualityReport: InputQualityReport };
}

import type { InvestmentThesisSummary } from "./investmentThesisAnalyzer";
import type { AgentSection, DirectoryEntry, FieldResultMap } from "./agentScraper";

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
      } else if (typeof value === 'string') {
        sanitized[key] = normalizeFieldValue(key, value);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  });
}

/**
 * Normalize a field value based on its key name for consistent Excel output.
 * Handles phone numbers, URLs, currencies, booleans, and whitespace.
 */
function normalizeFieldValue(key: string, value: string): string {
  if (!value || value.trim() === '') return '';
  const v = value.trim();
  const k = key.toLowerCase();

  // Phone numbers — normalize to E.164-style: +1 (555) 123-4567
  if (/phone|tel|mobile|cell/.test(k)) {
    const digits = v.replace(/\D/g, '');
    if (digits.length === 10) return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
    if (digits.length === 11 && digits[0] === '1') return `+1 (${digits.slice(1,4)}) ${digits.slice(4,7)}-${digits.slice(7)}`;
    return v; // Return as-is if format is unrecognized
  }

  // URLs — ensure https:// prefix and remove trailing slash
  if (/url|website|linkedin|twitter|instagram|facebook|link/.test(k)) {
    if (v.startsWith('http://') || v.startsWith('https://')) {
      return v.replace(/\/$/, '');
    }
    if (v.startsWith('www.') || v.includes('.com') || v.includes('.io') || v.includes('.co')) {
      return `https://${v}`.replace(/\/$/, '');
    }
    return v;
  }

  // Currency — normalize to $X.XM or $XB format
  if (/aum|fund.?size|revenue|arr|mrr|raised|funding|investment|capital/.test(k)) {
    // Already formatted (e.g. "$500M", "$1.2B") — pass through
    if (/^\$[\d,.]+[MBKmkb]?$/.test(v)) return v;
    return v;
  }

  // Boolean-like fields — normalize to Yes/No
  if (/is_|has_|uses_|active|enabled/.test(k)) {
    const lower = v.toLowerCase();
    if (['true', 'yes', '1', 'y'].includes(lower)) return 'Yes';
    if (['false', 'no', '0', 'n'].includes(lower)) return 'No';
    return v;
  }

  // Email — lowercase
  if (/email|e-mail/.test(k)) return v.toLowerCase();

  // Collapse excessive whitespace and newlines
  return v.replace(/\s+/g, ' ').trim();
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
 * Try to parse a value as a JSON array. Returns null if not valid JSON array.
 */
function tryParseJsonArray(value: string): Array<Record<string, string>> | null {
  if (!value || !value.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === "object") {
      return parsed;
    }
  } catch { /* not valid JSON */ }
  return null;
}

/**
 * Expand array sections into multiple columns per item.
 * E.g., "decision_makers" with [{name:"John", title:"CEO"}] becomes:
 *   "Decision Makers 1 - Name": "John"
 *   "Decision Makers 1 - Title": "CEO"
 *   "Decision Makers 2 - Name": ...
 */
function expandArraySection(
  section: AgentSection,
  value: string,
  maxExpand = 5,
): Record<string, string> {
  const result: Record<string, string> = {};
  const items = tryParseJsonArray(value);

  if (!items) {
    // Not a JSON array — store as-is (backward compatibility)
    result[section.label] = value;
    return result;
  }

  // Get field names from arraySchema or from the first item
  const fieldNames = section.arraySchema
    ? Object.keys(section.arraySchema)
    : Object.keys(items[0]).filter(k => k !== "quote_source");

  for (let i = 0; i < Math.min(items.length, maxExpand); i++) {
    const item = items[i];
    const prefix = `${section.label} ${i + 1}`;
    for (const field of fieldNames) {
      const columnName = `${prefix} - ${field.charAt(0).toUpperCase() + field.slice(1).replace(/_/g, " ")}`;
      result[columnName] = String(item[field] ?? "");
    }
  }

  // If there are more items than maxExpand, add a count indicator
  if (items.length > maxExpand) {
    result[`${section.label} (Total)`] = String(items.length);
  }

  return result;
}

export function createAgentOutputExcel(
  sections: AgentSection[],
  profileResults: Array<Record<string, string>>,
  collectedUrls: DirectoryEntry[],
  fieldResultsMap?: Array<{ companyName: string; websiteUrl: string; fieldResults: FieldResultMap }>,
  originalColumns?: string[],
): Buffer {
  const workbook = XLSX.utils.book_new();

  // Separate scalar sections from array sections.
  // Array sections (those with arraySchema) get their own dedicated sheets;
  // scalar sections appear as columns in the main Results sheet.
  const arraySectionsList = sections.filter(s => s.arraySchema);
  const scalarSectionsList = sections.filter(s => !s.arraySchema);
  const arraySectionKeys = new Set(arraySectionsList.map(s => s.key));

  // Section label set — used to avoid duplicating columns from the original input.
  const sectionLabels = new Set(scalarSectionsList.map(s => s.label));

  // ── Sheet 1: Results ──────────────────────────────────────────────────────
  // Contains only scalar fields. Array sections are replaced with a summary
  // count column (e.g. "Team Members (Count)") so the sheet stays readable.
  // The full array data lives in its own dedicated sheet below.
  if (profileResults.length > 0) {
    const rows = profileResults.map((r) => {
      const row: Record<string, string> = {};

      // Scalar fields first (enriched data — left columns)
      for (const s of scalarSectionsList) {
        row[s.label] = r[s.key] ?? "";
      }

      // Summary count for each array section
      for (const s of arraySectionsList) {
        const items = tryParseJsonArray(r[s.key] ?? "");
        row[`${s.label} (Count)`] = items ? String(items.length) : (r[s.key] ? "1" : "0");
      }

      // Original input columns after — preserves meaningful columns from the source file.
      // Skip internal keys, CSS-like names, HTML tag names, and URL-like strings.
      if (originalColumns) {
        for (const col of originalColumns) {
          if (sectionLabels.has(col)) continue;           // already in enriched columns
          if (col.endsWith(" (Count)")) continue;         // summary count column
          if (col === "__inputIndex") continue;           // internal sort key
          if (/^[a-z][a-z0-9-]*(\s+src)?$/.test(col)) continue;  // CSS class / HTML tag (e.g. "table", "table src", "text-primary")
          if (/^https?:\/\//.test(col)) continue;        // URL as column name
          row[col] = r[col] ?? "";
        }
      }
      return row;
    });
    const sanitizedRows = sanitizeForExcel(rows);
    const sheet = XLSX.utils.json_to_sheet(sanitizedRows);
    XLSX.utils.book_append_sheet(workbook, sheet, "Results");
  } else {
    const sheet = XLSX.utils.aoa_to_sheet([["No profile results found"]]);
    XLSX.utils.book_append_sheet(workbook, sheet, "Results");
  }

  // ── Dedicated sheets for each array section ───────────────────────────────
  // Each array section (e.g. "Team Members", "Portfolio Companies",
  // "Decision Makers") gets its own sheet with one row per extracted item,
  // anchored by Company Name and Website URL for easy VLOOKUP joins.
  for (const s of arraySectionsList) {
    const arrayRows: Array<Record<string, string>> = [];

    for (const r of profileResults) {
      // Resolve company identity from common key variants
      const companyName =
        r["company_name"] ?? r["companyName"] ?? r["Company Name"] ?? r["name"] ?? "";
      const websiteUrl =
        r["website_url"] ?? r["websiteUrl"] ?? r["Website URL"] ?? r["website"] ?? r["Website"] ?? "";

      const items = tryParseJsonArray(r[s.key] ?? "");

      if (!items || items.length === 0) {
        // Emit one empty row so every company appears in the sheet (easier auditing)
        const emptyRow: Record<string, string> = {
          "Company Name": companyName,
          "Website": websiteUrl,
        };
        if (s.arraySchema) {
          for (const field of Object.keys(s.arraySchema)) {
            emptyRow[field.charAt(0).toUpperCase() + field.slice(1).replace(/_/g, " ")] = "";
          }
        }
        arrayRows.push(emptyRow);
        continue;
      }

      const fieldNames = s.arraySchema
        ? Object.keys(s.arraySchema)
        : Object.keys(items[0]).filter(k => k !== "quote_source");

      for (const item of items) {
        const row: Record<string, string> = {
          "Company Name": companyName,
          "Website": websiteUrl,
        };
        for (const field of fieldNames) {
          const colName = field.charAt(0).toUpperCase() + field.slice(1).replace(/_/g, " ");
          row[colName] = String(item[field] ?? "");
        }
        arrayRows.push(row);
      }
    }

    if (arrayRows.length > 0) {
      const sanitized = sanitizeForExcel(arrayRows);
      const arraySheet = XLSX.utils.json_to_sheet(sanitized);
      // Excel sheet names are limited to 31 characters
      const sheetName = s.label.slice(0, 31);
      XLSX.utils.book_append_sheet(workbook, arraySheet, sheetName);
    }
  }

  // ── Sources sheet: confidence + source URL per field ─────────────────────
  if (fieldResultsMap && fieldResultsMap.length > 0) {
    const sourceRows = fieldResultsMap.map(({ companyName, websiteUrl, fieldResults }) => {
      const row: Record<string, string> = {
        "Company Name": companyName,
        "Website": websiteUrl,
      };
      for (const s of sections) {
        const fr = fieldResults[s.key];
        const conf = fr?.confidence ?? 0;
        const method = fr?.extractionMethod ?? "unknown";
        const confLabel = conf >= 0.9 ? "High" : conf >= 0.7 ? "Good" : conf >= 0.4 ? "Partial" : "Not found";
        row[`${s.label} (Confidence)`] = fr?.value ? `${confLabel} (${(conf * 100).toFixed(0)}%)` : "Not found";
        row[`${s.label} (Source)`] = method;
        row[`${s.label} (Source URL)`] = fr?.sourceUrl ?? "";
      }
      return row;
    });
    const sanitizedSourceRows = sanitizeForExcel(sourceRows);
    const sourceSheet = XLSX.utils.json_to_sheet(sanitizedSourceRows);
    XLSX.utils.book_append_sheet(workbook, sourceSheet, "Sources");
  }

  // ── Collected URLs sheet ──────────────────────────────────────────────────
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

  return XLSX.write(workbook, {
    type: "buffer",
    bookType: "xlsx",
    compression: true,
    bookSST: false,
  });
}
