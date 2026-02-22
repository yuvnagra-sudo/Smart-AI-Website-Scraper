/**
 * Investment Thesis Analyzer
 * Aggregates firm-level insights for the summary sheet
 */

import type { EnrichedVCData, TeamMemberData, PortfolioCompanyData } from "./excelProcessor";

export interface InvestmentThesisSummary {
  vcFirm: string;
  websiteUrl: string;
  investorType: string;
  primaryFocusAreas: string; // Top 3 niches
  emergingInterests: string; // Niches from recent investments
  preferredStages: string;
  averageCheckSize: string;
  recentInvestmentPace: string; // e.g., "3 investments in last 6 months"
  keyDecisionMakers: string; // Tier 1 partners
  totalTeamSize: number;
  tier1Count: number;
  tier2Count: number;
  portfolioSize: number;
  recentPortfolioCount: number; // Last 6 months
  talkingPoints: string; // AI-generated insights
}

/**
 * Calculate average check size from portfolio companies
 */
function estimateAverageCheckSize(portfolioCompanies: PortfolioCompanyData[]): string {
  // This is a placeholder - in reality, we'd need funding amount data
  // For now, we'll return a generic estimate based on investment stage
  if (portfolioCompanies.length === 0) {
    return "Unknown";
  }

  // Count stage mentions in portfolio
  const stageKeywords = {
    seed: ["seed", "pre-seed"],
    seriesA: ["series a", "series-a"],
    seriesB: ["series b", "series-b"],
    growth: ["growth", "series c", "series d"],
  };

  let seedCount = 0;
  let seriesACount = 0;
  let seriesBCount = 0;
  let growthCount = 0;

  for (const company of portfolioCompanies) {
    const text = `${company.portfolioCompany} ${company.investmentNiche}`.toLowerCase();
    
    if (stageKeywords.seed.some(k => text.includes(k))) seedCount++;
    if (stageKeywords.seriesA.some(k => text.includes(k))) seriesACount++;
    if (stageKeywords.seriesB.some(k => text.includes(k))) seriesBCount++;
    if (stageKeywords.growth.some(k => text.includes(k))) growthCount++;
  }

  // Estimate based on dominant stage
  if (seedCount > seriesACount && seedCount > seriesBCount) {
    return "$500K - $2M (Seed stage focus)";
  } else if (seriesACount > seriesBCount && seriesACount > growthCount) {
    return "$2M - $10M (Series A focus)";
  } else if (seriesBCount > 0 || growthCount > 0) {
    return "$10M - $50M+ (Growth stage focus)";
  }

  return "Varies by stage";
}

/**
 * Calculate recent investment pace
 */
function calculateInvestmentPace(portfolioCompanies: PortfolioCompanyData[]): string {
  const now = new Date();
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
  const oneYearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());

  let last6Months = 0;
  let last12Months = 0;

  for (const company of portfolioCompanies) {
    if (company.investmentDate && company.investmentDate !== "Unknown") {
      const investmentDate = new Date(company.investmentDate);
      
      if (investmentDate >= sixMonthsAgo) {
        last6Months++;
      }
      if (investmentDate >= oneYearAgo) {
        last12Months++;
      }
    }
  }

  if (last6Months > 0) {
    return `${last6Months} investment${last6Months > 1 ? 's' : ''} in last 6 months`;
  } else if (last12Months > 0) {
    return `${last12Months} investment${last12Months > 1 ? 's' : ''} in last 12 months`;
  }

  return "Investment pace unknown";
}

/**
 * Extract emerging interests from recent portfolio companies
 */
function extractEmergingInterests(portfolioCompanies: PortfolioCompanyData[]): string {
  const now = new Date();
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());

  const recentNiches = new Map<string, number>();

  for (const company of portfolioCompanies) {
    if (company.investmentDate && company.investmentDate !== "Unknown") {
      const investmentDate = new Date(company.investmentDate);
      
      if (investmentDate >= sixMonthsAgo && company.investmentNiche) {
        const niches = company.investmentNiche.split(",").map(n => n.trim());
        for (const niche of niches) {
          if (niche) {
            recentNiches.set(niche, (recentNiches.get(niche) || 0) + 1);
          }
        }
      }
    }
  }

  if (recentNiches.size === 0) {
    return "No recent investment data available";
  }

  // Sort by frequency and take top 3
  const sorted = Array.from(recentNiches.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([niche]) => niche);

  return sorted.join(", ");
}

/**
 * Generate talking points based on firm data
 */
function generateTalkingPoints(
  firm: EnrichedVCData,
  teamMembers: TeamMemberData[],
  portfolioCompanies: PortfolioCompanyData[]
): string {
  const points: string[] = [];

  // Investment focus
  if (firm.investmentNiches) {
    const niches = firm.investmentNiches.split(",").slice(0, 2).join(" and ");
    points.push(`Focused on ${niches}`);
  }

  // Stage preference
  if (firm.investmentStages) {
    const stages = firm.investmentStages.split(",").slice(0, 2).join(" and ");
    points.push(`Invests in ${stages} companies`);
  }

  // Recent activity
  const recentCount = portfolioCompanies.filter(c => {
    if (!c.investmentDate || c.investmentDate === "Unknown") return false;
    const date = new Date(c.investmentDate);
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    return date >= sixMonthsAgo;
  }).length;

  if (recentCount > 0) {
    points.push(`${recentCount} recent investment${recentCount > 1 ? 's' : ''} in last 6 months`);
  }

  // Team size
  const tier1 = teamMembers.filter(m => m.decisionMakerTier === "Tier 1").length;
  if (tier1 > 0) {
    points.push(`${tier1} senior partner${tier1 > 1 ? 's' : ''} available`);
  }

  return points.join("; ");
}

/**
 * Analyze firm data and generate investment thesis summary
 */
export function analyzeInvestmentThesis(
  firm: EnrichedVCData,
  teamMembers: TeamMemberData[],
  portfolioCompanies: PortfolioCompanyData[]
): InvestmentThesisSummary {
  // Extract primary focus areas (top 3 niches)
  const niches = firm.investmentNiches ? firm.investmentNiches.split(",").map(n => n.trim()) : [];
  const primaryFocusAreas = niches.slice(0, 3).join(", ") || "Not specified";

  // Extract emerging interests from recent portfolio
  const emergingInterests = extractEmergingInterests(portfolioCompanies);

  // Count team members by tier
  const tier1Count = teamMembers.filter(m => m.decisionMakerTier === "Tier 1").length;
  const tier2Count = teamMembers.filter(m => m.decisionMakerTier === "Tier 2").length;

  // Get key decision makers (Tier 1 names)
  const keyDecisionMakers = teamMembers
    .filter(m => m.decisionMakerTier === "Tier 1")
    .slice(0, 5)
    .map(m => `${m.name} (${m.title})`)
    .join("; ") || "Not identified";

  // Calculate recent portfolio count
  const now = new Date();
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
  const recentPortfolioCount = portfolioCompanies.filter(c => {
    if (!c.investmentDate || c.investmentDate === "Unknown") return false;
    const date = new Date(c.investmentDate);
    return date >= sixMonthsAgo;
  }).length;

  return {
    vcFirm: firm.companyName,
    websiteUrl: firm.websiteUrl,
    investorType: firm.investorType || "Not specified",
    primaryFocusAreas,
    emergingInterests,
    preferredStages: firm.investmentStages || "Not specified",
    averageCheckSize: estimateAverageCheckSize(portfolioCompanies),
    recentInvestmentPace: calculateInvestmentPace(portfolioCompanies),
    keyDecisionMakers,
    totalTeamSize: teamMembers.length,
    tier1Count,
    tier2Count,
    portfolioSize: portfolioCompanies.length,
    recentPortfolioCount,
    talkingPoints: generateTalkingPoints(firm, teamMembers, portfolioCompanies),
  };
}

/**
 * Generate all investment thesis summaries for enriched firms
 */
export function generateInvestmentThesisSummaries(
  firms: EnrichedVCData[],
  allTeamMembers: TeamMemberData[],
  allPortfolioCompanies: PortfolioCompanyData[]
): InvestmentThesisSummary[] {
  return firms.map(firm => {
    const firmTeamMembers = allTeamMembers.filter(m => m.vcFirm === firm.companyName);
    const firmPortfolio = allPortfolioCompanies.filter(p => p.vcFirm === firm.companyName);
    
    return analyzeInvestmentThesis(firm, firmTeamMembers, firmPortfolio);
  });
}
