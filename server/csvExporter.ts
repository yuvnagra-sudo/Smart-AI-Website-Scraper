/**
 * CSV Export Utility
 * Provides unlimited-row CSV export as an alternative to Excel
 */

import type { EnrichedVCData, TeamMemberData, PortfolioCompanyData } from "./excelProcessor";
import type { InvestmentThesisSummary } from "./investmentThesisAnalyzer";

/**
 * Escape CSV field value
 */
function escapeCSV(value: any): string {
  if (value === null || value === undefined) {
    return "";
  }
  
  const str = String(value);
  
  // If the value contains comma, quote, or newline, wrap in quotes and escape quotes
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  
  return str;
}

/**
 * Convert array of objects to CSV string
 */
function arrayToCSV<T extends Record<string, any>>(data: T[]): string {
  if (data.length === 0) {
    return "";
  }
  
  // Get headers from first object
  const headers = Object.keys(data[0]);
  
  // Create header row
  const headerRow = headers.map(escapeCSV).join(",");
  
  // Create data rows
  const dataRows = data.map(row => 
    headers.map(header => escapeCSV(row[header])).join(",")
  );
  
  return [headerRow, ...dataRows].join("\n");
}

/**
 * Create a multi-sheet CSV export (as a ZIP file with multiple CSV files)
 * Returns a Buffer containing the ZIP file
 */
export async function createCSVExport(
  firms: EnrichedVCData[],
  teamMembers: TeamMemberData[],
  portfolioCompanies: PortfolioCompanyData[],
  investmentThesisSummaries?: InvestmentThesisSummary[],
): Promise<{ buffer: Buffer; filename: string }> {
  // For simplicity, we'll create a single CSV with all data combined
  // In a production environment, you might want to use a ZIP library to create multiple CSVs
  
  // Create separate CSV strings
  const firmsCSV = arrayToCSV(firms);
  const teamMembersCSV = arrayToCSV(teamMembers);
  const portfolioCSV = arrayToCSV(portfolioCompanies);
  const summaryCSV = investmentThesisSummaries ? arrayToCSV(investmentThesisSummaries) : "";
  
  // Combine all CSVs with section headers
  const combinedCSV = [
    "=== VC FIRMS ===",
    firmsCSV,
    "",
    "=== TEAM MEMBERS ===",
    teamMembersCSV,
    "",
    "=== PORTFOLIO COMPANIES ===",
    portfolioCSV,
  ];
  
  if (summaryCSV) {
    combinedCSV.push("", "=== INVESTMENT THESIS SUMMARY ===", summaryCSV);
  }
  
  const csvContent = combinedCSV.join("\n");
  const buffer = Buffer.from(csvContent, "utf-8");
  
  return {
    buffer,
    filename: "vc-enrichment-export.csv",
  };
}

/**
 * Create individual CSV files for each sheet
 */
export function createIndividualCSVs(
  firms: EnrichedVCData[],
  teamMembers: TeamMemberData[],
  portfolioCompanies: PortfolioCompanyData[],
  investmentThesisSummaries?: InvestmentThesisSummary[],
): { name: string; buffer: Buffer }[] {
  const files: { name: string; buffer: Buffer }[] = [];
  
  if (firms.length > 0) {
    files.push({
      name: "vc-firms.csv",
      buffer: Buffer.from(arrayToCSV(firms), "utf-8"),
    });
  }
  
  if (teamMembers.length > 0) {
    files.push({
      name: "team-members.csv",
      buffer: Buffer.from(arrayToCSV(teamMembers), "utf-8"),
    });
  }
  
  if (portfolioCompanies.length > 0) {
    files.push({
      name: "portfolio-companies.csv",
      buffer: Buffer.from(arrayToCSV(portfolioCompanies), "utf-8"),
    });
  }
  
  if (investmentThesisSummaries && investmentThesisSummaries.length > 0) {
    files.push({
      name: "investment-thesis.csv",
      buffer: Buffer.from(arrayToCSV(investmentThesisSummaries), "utf-8"),
    });
  }
  
  return files;
}
