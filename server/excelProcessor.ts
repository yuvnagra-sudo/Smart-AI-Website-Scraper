import * as XLSX from "xlsx";
import axios from "axios";

export interface VCFirmInput {
  companyName: string;
  websiteUrl: string;
  description: string;
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

export async function parseInputExcel(fileUrl: string): Promise<VCFirmInput[]> {
  let buffer: Buffer;
  
  // Check if it's a local file path (for testing) or a URL
  if (fileUrl.startsWith('/') || fileUrl.startsWith('./')) {
    // Local file path - read directly from filesystem
    const fs = await import('fs/promises');
    buffer = await fs.readFile(fileUrl);
  } else {
    // URL - download the file
    const response = await axios.get(fileUrl, { responseType: "arraybuffer" });
    buffer = Buffer.from(response.data);
  }

  // Detect file type from URL or content
  const isCsv = fileUrl.toLowerCase().endsWith('.csv');
  
  // Parse file (supports both Excel and CSV)
  const workbook = XLSX.read(buffer, { 
    type: "buffer", 
    cellDates: false, 
    cellText: true,
    // For CSV files, XLSX will auto-detect and parse correctly
  });
  
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("No sheets found in file");

  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error("Sheet not found");

  // Use raw: false to get text values and prevent Excel auto-formatting
  const data = XLSX.utils.sheet_to_json(sheet, { raw: false, defval: "" }) as any[];

  if (data.length === 0) {
    throw new Error("File is empty or has no data rows");
  }

  // Get all column names from the first row
  const firstRow = data[0];
  const availableColumns = Object.keys(firstRow || {});

  // Helper function to find column case-insensitively
  const findColumn = (row: any, possibleNames: string[]): string | undefined => {
    for (const name of possibleNames) {
      // Try exact match first
      if (row[name] !== undefined) return String(row[name]);
      
      // Try case-insensitive match
      const lowerName = name.toLowerCase();
      for (const key of Object.keys(row)) {
        if (key.toLowerCase() === lowerName || key.toLowerCase().replace(/[\s_-]/g, '') === lowerName.replace(/[\s_-]/g, '')) {
          return String(row[key]);
        }
      }
    }
    return undefined;
  };

  // Validate and map data
  const firms: VCFirmInput[] = [];
  const skippedRows: number[] = [];

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (!row) continue;

    const companyName = findColumn(row, [
      "Company Name",
      "company_name",
      "CompanyName",
      "company name",
      "Company",
      "company",
      "Name",
      "name",
      "Firm Name",
      "firm_name",
      "Firm",
      "firm",
    ]);

    const websiteUrl = findColumn(row, [
      "Company Website URL",
      "website_url",
      "WebsiteURL",
      "Company Website",
      "company website url",
      "Corporate Website",
      "corporate website",
      "Corporate LinkedIn URL",
      "corporate linkedin url",
      "Website",
      "website",
      "URL",
      "url",
      "Site",
      "site",
    ]);

    const description = findColumn(row, [
      "LinkedIn Description",
      "linkedin_description",
      "Description",
      "description",
      "linkedin description",
      "About",
      "about",
      "Summary",
      "summary",
    ]);

    // Only require companyName and websiteUrl - description is optional
    if (!companyName || !websiteUrl) {
      console.log(`[Excel Parser] Skipping row ${i + 2}: missing required fields (companyName=${!!companyName}, websiteUrl=${!!websiteUrl})`);
      skippedRows.push(i + 2); // +2 because Excel rows are 1-indexed and header is row 1
      continue;
    }
    
    console.log(`[Excel Parser] Parsed firm: ${companyName}`);

    firms.push({
      companyName,
      websiteUrl,
      description: description || '', // Use empty string if no description
    });
  }

  console.log(`[Excel Parser] Successfully parsed ${firms.length} firms, skipped ${skippedRows.length} rows`);
  
  if (firms.length === 0) {
    const columnList = availableColumns.join(", ");
    throw new Error(
      `No valid data found. Your file has columns: [${columnList}]. ` +
      `Required columns (case-insensitive): Company Name (or Name/Firm Name), ` +
      `Company Website URL (or Website/URL), and LinkedIn Description (or Description/About/Summary). ` +
      (skippedRows.length > 0 ? `Skipped rows: ${skippedRows.join(", ")}` : "")
    );
  }

  return firms;
}

import type { InvestmentThesisSummary } from "./investmentThesisAnalyzer";

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
