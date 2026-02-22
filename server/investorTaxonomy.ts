/**
 * Investor Type and Stage Taxonomy
 * Comprehensive classification system for investor types and investment stages
 */

export const INVESTOR_TYPES = {
  "Venture Capital (VC)": {
    description: "Firms that invest in high-growth startups in exchange for equity",
    keywords: ["venture capital", "vc firm", "venture fund", "vc fund", "venture partners"],
  },
  "Angel Network": {
    description: "Groups of individual angel investors who pool resources and expertise",
    keywords: ["angel network", "angel group", "angel investors", "angel syndicate"],
  },
  "Private Equity (PE)": {
    description: "Firms that invest in mature companies, often through buyouts or significant stakes",
    keywords: ["private equity", "pe firm", "buyout", "growth equity", "pe fund"],
  },
  "Accelerator": {
    description: "Programs that provide mentorship, resources, and funding to early-stage startups in cohorts",
    keywords: ["accelerator", "startup accelerator", "cohort", "demo day", "acceleration program"],
  },
  "Incubator": {
    description: "Organizations that nurture early-stage companies with workspace, mentorship, and resources",
    keywords: ["incubator", "startup incubator", "innovation lab", "entrepreneurship center"],
  },
  "Venture Studio": {
    description: "Companies that build and launch multiple startups using their own ideas and resources",
    keywords: ["venture studio", "startup studio", "company builder", "venture builder"],
  },
  "Corporate Venture Capital (CVC)": {
    description: "Investment arms of large corporations that invest in startups strategically",
    keywords: ["corporate venture", "cvc", "corporate vc", "strategic investment"],
  },
  "Family Office": {
    description: "Private wealth management firms that invest on behalf of high-net-worth families",
    keywords: ["family office", "single family office", "multi-family office", "private wealth"],
  },
  "Micro VC": {
    description: "Small venture capital firms with fund sizes typically under $50M",
    keywords: ["micro vc", "micro fund", "emerging manager", "small fund"],
  },
  "Venture Debt": {
    description: "Firms that provide debt financing to venture-backed companies",
    keywords: ["venture debt", "venture lending", "growth debt", "debt financing"],
  },
  "Crowdfunding Platform": {
    description: "Online platforms that enable many individuals to invest small amounts in startups",
    keywords: ["crowdfunding", "equity crowdfunding", "crowdfund", "syndicate platform"],
  },
  "Government Fund": {
    description: "Public sector investment vehicles supporting innovation and economic development",
    keywords: ["government fund", "public investment", "sovereign fund", "innovation fund"],
  },
} as const;

export const INVESTMENT_STAGES = {
  "Pre-Seed": {
    description: "Earliest stage, often friends & family or initial angel investment",
    keywords: ["pre-seed", "preseed", "friends and family", "pre seed"],
    typical_range: "$50K - $500K",
  },
  "Seed": {
    description: "Early funding to prove product-market fit and build initial traction",
    keywords: ["seed", "seed round", "seed stage", "seed funding"],
    typical_range: "$500K - $3M",
  },
  "Series A": {
    description: "First significant institutional round to scale proven business model",
    keywords: ["series a", "series-a", "round a", "series a round"],
    typical_range: "$2M - $15M",
  },
  "Series B": {
    description: "Scaling operations, expanding market reach, and building team",
    keywords: ["series b", "series-b", "round b", "series b round"],
    typical_range: "$10M - $50M",
  },
  "Series C": {
    description: "Expanding to new markets, acquiring competitors, or preparing for exit",
    keywords: ["series c", "series-c", "round c", "series c round"],
    typical_range: "$30M - $100M",
  },
  "Series D+": {
    description: "Late-stage rounds for further expansion or bridge to IPO",
    keywords: ["series d", "series e", "series f", "late stage", "late-stage"],
    typical_range: "$50M+",
  },
  "Growth/Expansion": {
    description: "Capital for mature companies to expand operations or enter new markets",
    keywords: ["growth", "expansion", "growth equity", "growth stage", "scale-up"],
    typical_range: "$50M+",
  },
  "Bridge": {
    description: "Short-term financing between major rounds or before acquisition/IPO",
    keywords: ["bridge", "bridge round", "bridge financing", "interim financing"],
    typical_range: "Varies",
  },
  "Mezzanine": {
    description: "Hybrid debt-equity financing for mature companies",
    keywords: ["mezzanine", "mezzanine financing", "subordinated debt"],
    typical_range: "$10M+",
  },
  "IPO/Public": {
    description: "Investment in companies going public or already public",
    keywords: ["ipo", "public offering", "public markets", "crossover"],
    typical_range: "$50M+",
  },
} as const;

export function formatInvestorTypesForPrompt(): string {
  const result: string[] = ["\nInvestor Types:"];
  
  for (const [type, info] of Object.entries(INVESTOR_TYPES)) {
    result.push(`  - ${type}: ${info.description}`);
  }
  
  return result.join("\n");
}

export function formatInvestmentStagesForPrompt(): string {
  const result: string[] = ["\nInvestment Stages:"];
  
  for (const [stage, info] of Object.entries(INVESTMENT_STAGES)) {
    result.push(`  - ${stage} (${info.typical_range}): ${info.description}`);
  }
  
  return result.join("\n");
}

export function getAllInvestorTypeKeywords(): string[] {
  const keywords: string[] = [];
  for (const info of Object.values(INVESTOR_TYPES)) {
    keywords.push(...info.keywords);
  }
  return keywords;
}

export function getAllInvestmentStageKeywords(): string[] {
  const keywords: string[] = [];
  for (const info of Object.values(INVESTMENT_STAGES)) {
    keywords.push(...info.keywords);
  }
  return keywords;
}
