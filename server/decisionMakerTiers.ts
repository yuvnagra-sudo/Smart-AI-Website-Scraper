/**
 * Decision Maker Tier Classification for VC Deal Sourcing Roles
 * 
 * Focus: Identify people involved in DEAL SOURCING (finding and evaluating investments)
 * Exclude: LPs, Operating Partners (post-investment), support staff
 * 
 * Tier 1: Senior Partners - Make final investment decisions
 * Tier 2: Mid-level Deal Team - Lead due diligence and deal execution  
 * Tier 3: Junior Deal Team - Source deals, conduct initial evaluations
 * Exclude: Non-deal sourcing roles (LPs, ops, support)
 */

export type DecisionMakerTier = "Tier 1" | "Tier 2" | "Tier 3" | "Exclude";

export interface TierClassification {
  tier: DecisionMakerTier;
  priority: number;
  description: string;
}

/**
 * TIER 1: Senior Partners (Decision Makers)
 * - Make final investment decisions
 * - Sit on Investment Committee
 * - Strategic direction of firm
 */
const TIER1_PATTERNS = [
  // C-Suite (investment-focused)
  "chief executive officer",
  "ceo",
  "chief investment officer",
  "cio",
  
  // Core partner titles
  "managing partner",
  "general partner",
  "founding partner",
  "senior partner",
  "equity partner",
  "investment partner",
  
  // Managing Director variants
  "managing director",
  "md",
  
  // Partner (will check for exclusions separately)
  "partner",
];

/**
 * TIER 2: Senior Deal Team (Deal Leaders)
 * - Lead due diligence processes
 * - Lead deal execution
 * - Bridge between associates and partners
 */
const TIER2_PATTERNS = [
  // Principal titles
  "principal",
  "venture principal",
  "investment principal",
  
  // VP titles (investment-focused)
  "vice president",
  "vp",
  "vice-president",
  "vp of investments",
  "vice president of investments",
  
  // Senior Associate
  "senior associate",
  "sr associate",
  "sr. associate",
  
  // Investment Manager (mid-level deal team)
  "senior investment manager",
  "investment manager",
  
  // Investor Relations (often involved in deal flow and LP communications)
  "investor relations",
  "ir partner",
  "head of investor relations",
];

/**
 * TIER 3: Junior Deal Team (Deal Sourcers)
 * - Source deals and attend industry events
 * - Conduct initial evaluations
 * - Support due diligence
 * - INCLUDES ASSOCIATES AND ANALYSTS (per user request)
 */
const TIER3_PATTERNS = [
  // Associate titles (investment-focused only)
  "associate",
  "investment associate",
  "venture associate",
  
  // Analyst titles (investment-focused only)
  "analyst",
  "investment analyst",
  "venture analyst",
];

/**
 * EXCLUDE: Non-Deal Sourcing Roles
 * - Limited Partners (passive investors)
 * - Operating Partners (post-investment support)
 * - Venture Partners (often part-time advisors)
 * - Support staff (legal, finance, admin, marketing)
 */
const EXCLUDE_PATTERNS = [
  // Limited Partners
  "limited partner",
  "lp",
  " lp ",
  "investor",
  "angel investor",
  
  // Operating/Venture Partners (post-investment, not deal sourcing)
  "operating partner",
  "venture partner",
  "strategic partner",
  "executive partner",
  "entrepreneur in residence",
  "eir",
  
  // Portfolio/Post-Investment (NOT deal sourcing)
  "portfolio manager",
  "portfolio director",
  "portfolio operations",
  "portfolio manger", // common typo
  
  // Operations/Support (NOT deal sourcing)
  "investment operations",
  "investment data analyst",
  "data analyst",
  "data strategist",
  "data engineer",
  "operations analyst",
  "program manager",
  "program associate",
  "accelerator manager",
  "community manager",
  "general manager",
  
  // Capital Formation/Fundraising (NOT deal sourcing)
  "capital formation",
  "fund accountant",
  "fund controller",
  "financial analyst",
  
  // C-Suite / Support (non-investment)
  "chief financial officer",
  "cfo",
  "chief operating officer",
  "coo",
  "chief technology officer",
  "cto",
  "chief marketing officer",
  "cmo",
  "chief people officer",
  "chief commercial officer",
  "head of",
  "director of",
  
  // Functional roles
  "legal",
  "counsel",
  "attorney",
  "compliance",
  "finance",
  "accounting",
  "accountant",
  "controller",
  "treasurer",
  "operations",
  "admin",
  "assistant",
  "coordinator",
  "marketing",
  "communications",
  "public relations",
  "pr",
  "human resources",
  "hr",
  "recruiter",
  "talent",
  // Removed "investor relations" - moved to Tier 2
  // "investor relations",
  // "ir",
  "learning",
  "education",
  "designer",
  "experience",
  
  // Non-investment roles
  "advisor",
  "consultant",
  "board member",
  "board observer",
  "fellow",
  "scholar",
];

/**
 * Check if title matches any pattern in a list (case-insensitive, whole-word matching)
 */
function matchesPattern(title: string, patterns: string[]): boolean {
  const titleLower = title.toLowerCase().trim();
  
  return patterns.some(pattern => {
    const patternLower = pattern.toLowerCase();
    
    // Exact match
    if (titleLower === patternLower) return true;
    
    // Word boundary match (pattern appears as a complete word)
    const regex = new RegExp(`\\b${patternLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    return regex.test(titleLower);
  });
}

/**
 * Check if title contains investment-related keywords
 */
function hasInvestmentKeywords(title: string): boolean {
  const titleLower = title.toLowerCase();
  const keywords = [
    "invest",
    "venture",
    "vc",
    "capital",
    "fund",
    "portfolio",
    "deal",
    "partner",
    "principal",
    "associate",
    "analyst",
  ];
  
  return keywords.some(keyword => titleLower.includes(keyword));
}

/**
 * Classify a job title into a decision maker tier
 */
export function classifyDecisionMakerTier(title: string): TierClassification {
  if (!title || title.trim().length === 0) {
    // Changed from "Exclude" to "Tier 3" - empty titles are common on VC websites
    // where people are listed by name without explicit titles
    // Users can filter in Excel if they want to exclude these
    return {
      tier: "Tier 3",
      priority: 3,
      description: "Unknown role (empty title) - Defaulting to junior deal team",
    };
  }

  const titleLower = title.toLowerCase().trim();

  // Priority order: Check exclusions first for specific partner types, then tiers
  
  // Check for department-based classification FIRST (common on VC websites)
  // Many VC sites list people by department rather than explicit titles
  const investingDepartments = [
    "investing",
    "investment team",
    "investments",
    "deal team",
    // Sequoia-specific patterns
    "seed/early",
    "seed",
    "early stage",
    "growth",
    "growth stage",
  ];
  
  if (investingDepartments.some(dept => titleLower === dept || titleLower.includes(dept))) {
    // If only department is listed, assume Tier 1 (they're on the deal team)
    console.log(`[Tier Classifier] Department-based classification: "${title}" → Tier 1`);
    return {
      tier: "Tier 1",
      priority: 1,
      description: "Investment team member (department-based classification)",
    };
  }
  
  // Check for excluded partner types BEFORE generic "partner" pattern
  const excludedPartnerTypes = ["operating partner", "venture partner", "limited partner", "strategic partner", "executive partner"];
  if (matchesPattern(title, excludedPartnerTypes)) {
    return {
      tier: "Exclude",
      priority: 999,
      description: "Non-deal sourcing partner role",
    };
  }
  
  // TIER 1: Senior Partners
  if (matchesPattern(titleLower, TIER1_PATTERNS)) {
    // Special check: "Partner" alone could be Operating/Venture Partner
    if (titleLower === "partner") {
      // If it's just "partner", check for exclusion keywords
      if (matchesPattern(titleLower, EXCLUDE_PATTERNS)) {
        return {
          tier: "Exclude",
          priority: 999,
          description: "Non-deal sourcing partner role",
        };
      }
      // Assume investment partner if no exclusion
      return {
        tier: "Tier 1",
        priority: 1,
        description: "Senior Partner - Makes final investment decisions",
      };
    }
    
    return {
      tier: "Tier 1",
      priority: 1,
      description: "Senior Partner - Makes final investment decisions",
    };
  }

  // TIER 2: Senior Deal Team
  if (matchesPattern(titleLower, TIER2_PATTERNS)) {
    return {
      tier: "Tier 2",
      priority: 2,
      description: "Senior Deal Team - Leads due diligence and deal execution",
    };
  }

  // TIER 3: Junior Deal Team
  if (matchesPattern(titleLower, TIER3_PATTERNS)) {
    return {
      tier: "Tier 3",
      priority: 3,
      description: "Junior Deal Team - Sources deals and conducts initial evaluations",
    };
  }

  // EXCLUDE: Non-deal sourcing roles
  if (matchesPattern(titleLower, EXCLUDE_PATTERNS)) {
    return {
      tier: "Exclude",
      priority: 999,
      description: "Non-deal sourcing role",
    };
  }

  // UNKNOWN: Default based on investment keywords
  if (hasInvestmentKeywords(titleLower)) {
    console.log(`[Tier Classifier] Unknown investment-related title defaulting to Tier 3: "${title}"`);
    return {
      tier: "Tier 3",
      priority: 3,
      description: "Unknown investment role - Defaulting to junior deal team",
    };
  }

  // No investment keywords - likely support role
  console.log(`[Tier Classifier] Excluding non-investment title: "${title}"`);
  return {
    tier: "Exclude",
    priority: 999,
    description: "Non-investment role",
  };
}

/**
 * Filter team members to only include decision makers (Tier 1-3)
 */
export function filterDecisionMakers<T extends { title: string }>(
  teamMembers: T[],
  includeTiers: DecisionMakerTier[] = ["Tier 1", "Tier 2", "Tier 3"],
): T[] {
  return teamMembers.filter((member) => {
    const classification = classifyDecisionMakerTier(member.title);
    return includeTiers.includes(classification.tier);
  });
}

/**
 * Sort team members by decision-making priority
 */
export function sortByDecisionMakingPriority<T extends { title: string }>(
  teamMembers: T[],
): T[] {
  return [...teamMembers].sort((a, b) => {
    const tierA = classifyDecisionMakerTier(a.title);
    const tierB = classifyDecisionMakerTier(b.title);
    return tierA.priority - tierB.priority;
  });
}
