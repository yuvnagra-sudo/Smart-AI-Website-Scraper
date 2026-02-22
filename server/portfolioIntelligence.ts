/**
 * Portfolio Intelligence
 * Analyzes portfolio companies to extract investment patterns and trends
 */

export interface PortfolioCompanyWithScore {
  companyName: string;
  investmentDate: string;
  websiteUrl: string;
  investmentNiche: string[];
  dataSourceUrl: string;
  confidenceScore: string;
  recencyScore: number; // 0-100, higher = more recent
  recencyCategory: "Very Recent" | "Recent" | "Moderate" | "Old";
}

export interface InvestmentThesis {
  primaryFocus: string[];
  emergingInterests: string[];
  investmentPace: "Very Active" | "Active" | "Moderate" | "Slow";
  recentTrends: string;
}

/**
 * Calculate recency score based on investment date
 * Score: 100 (today) to 0 (5+ years ago)
 */
export function calculateRecencyScore(investmentDate: string): {
  score: number;
  category: "Very Recent" | "Recent" | "Moderate" | "Old";
} {
  try {
    const date = new Date(investmentDate);
    const now = new Date();
    const monthsAgo = (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24 * 30);

    let score: number;
    let category: "Very Recent" | "Recent" | "Moderate" | "Old";

    if (monthsAgo <= 6) {
      // Last 6 months: 80-100
      score = 100 - (monthsAgo / 6) * 20;
      category = "Very Recent";
    } else if (monthsAgo <= 12) {
      // 6-12 months: 60-80
      score = 80 - ((monthsAgo - 6) / 6) * 20;
      category = "Recent";
    } else if (monthsAgo <= 24) {
      // 1-2 years: 30-60
      score = 60 - ((monthsAgo - 12) / 12) * 30;
      category = "Moderate";
    } else {
      // 2+ years: 0-30
      score = Math.max(0, 30 - ((monthsAgo - 24) / 36) * 30);
      category = "Old";
    }

    return {
      score: Math.round(score),
      category,
    };
  } catch (error) {
    // If date parsing fails, assume old
    return {
      score: 0,
      category: "Old",
    };
  }
}

/**
 * Add recency scores to portfolio companies
 */
export function scorePortfolioByRecency(
  companies: Array<{
    companyName: string;
    investmentDate: string;
    websiteUrl: string;
    investmentNiche: string[];
    dataSourceUrl: string;
    confidenceScore: string;
  }>,
): PortfolioCompanyWithScore[] {
  return companies.map((company) => {
    const { score, category } = calculateRecencyScore(company.investmentDate);
    return {
      ...company,
      recencyScore: score,
      recencyCategory: category,
    };
  });
}

/**
 * Extract investment thesis from portfolio companies
 */
export function extractInvestmentThesis(
  companies: PortfolioCompanyWithScore[],
): InvestmentThesis {
  // Count niche occurrences
  const nicheCount: Record<string, number> = {};
  const recentNicheCount: Record<string, number> = {}; // Last 6 months

  for (const company of companies) {
    for (const niche of company.investmentNiche) {
      nicheCount[niche] = (nicheCount[niche] || 0) + 1;

      if (company.recencyCategory === "Very Recent") {
        recentNicheCount[niche] = (recentNicheCount[niche] || 0) + 1;
      }
    }
  }

  // Sort by frequency
  const sortedNiches = Object.entries(nicheCount)
    .sort(([, a], [, b]) => b - a)
    .map(([niche]) => niche);

  const sortedRecentNiches = Object.entries(recentNicheCount)
    .sort(([, a], [, b]) => b - a)
    .map(([niche]) => niche);

  // Primary focus: top 3 overall niches
  const primaryFocus = sortedNiches.slice(0, 3);

  // Emerging interests: niches that appear more in recent investments
  const emergingInterests = sortedRecentNiches
    .filter((niche) => {
      const recentCount = recentNicheCount[niche] || 0;
      const totalCount = nicheCount[niche] || 1;
      // Emerging if >50% of investments in this niche are recent
      return recentCount / totalCount > 0.5 && !primaryFocus.includes(niche);
    })
    .slice(0, 3);

  // Investment pace: based on very recent investments
  const veryRecentCount = companies.filter((c) => c.recencyCategory === "Very Recent").length;
  let investmentPace: "Very Active" | "Active" | "Moderate" | "Slow";

  if (veryRecentCount >= 3) {
    investmentPace = "Very Active";
  } else if (veryRecentCount >= 2) {
    investmentPace = "Active";
  } else if (veryRecentCount >= 1) {
    investmentPace = "Moderate";
  } else {
    investmentPace = "Slow";
  }

  // Recent trends description
  let recentTrends = "";
  if (emergingInterests.length > 0) {
    recentTrends = `Showing increased interest in ${emergingInterests.join(", ")}. `;
  }
  if (investmentPace === "Very Active" || investmentPace === "Active") {
    recentTrends += `Currently ${investmentPace.toLowerCase()} in making new investments.`;
  } else {
    recentTrends += `Investment activity has slowed recently.`;
  }

  return {
    primaryFocus,
    emergingInterests,
    investmentPace,
    recentTrends: recentTrends.trim(),
  };
}

/**
 * Detect patterns across recent investments
 */
export function detectInvestmentPatterns(
  companies: PortfolioCompanyWithScore[],
): {
  patterns: string[];
  confidence: "High" | "Medium" | "Low";
} {
  const patterns: string[] = [];
  const recentCompanies = companies.filter((c) => c.recencyCategory === "Very Recent" || c.recencyCategory === "Recent");

  if (recentCompanies.length === 0) {
    return {
      patterns: ["Insufficient recent investment data"],
      confidence: "Low",
    };
  }

  // Pattern 1: Niche clustering
  const nicheCount: Record<string, number> = {};
  for (const company of recentCompanies) {
    for (const niche of company.investmentNiche) {
      nicheCount[niche] = (nicheCount[niche] || 0) + 1;
    }
  }

  const dominantNiches = Object.entries(nicheCount)
    .filter(([, count]) => count >= 2)
    .map(([niche]) => niche);

  if (dominantNiches.length > 0) {
    patterns.push(`Concentrated focus on ${dominantNiches.join(", ")}`);
  }

  // Pattern 2: Investment frequency
  if (recentCompanies.length >= 3) {
    patterns.push("High investment velocity - actively deploying capital");
  } else if (recentCompanies.length === 0) {
    patterns.push("Low investment activity - may be between funds or selective");
  }

  // Pattern 3: Diversification
  const uniqueNiches = new Set(recentCompanies.flatMap((c) => c.investmentNiche));
  if (uniqueNiches.size >= 4) {
    patterns.push("Diversified portfolio approach across multiple sectors");
  } else if (uniqueNiches.size <= 2) {
    patterns.push("Highly focused investment strategy");
  }

  const confidence = recentCompanies.length >= 3 ? "High" : recentCompanies.length >= 2 ? "Medium" : "Low";

  return {
    patterns,
    confidence,
  };
}
