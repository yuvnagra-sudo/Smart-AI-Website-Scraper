/**
 * Decision Maker Tier Classification for General B2B Prospecting
 *
 * Classifies any job title into tiers relevant for B2B outreach.
 * Works across all industries and company types (not VC-specific).
 *
 * Tier 1: Budget Authority / Decision Makers
 *   C-suite, founders, owners, executive leadership — those who sign the deal
 *
 * Tier 2: Senior Influencers / Champions
 *   VPs, Directors, Head of [dept], senior managers — those who drive the decision
 *
 * Tier 3: Junior Influencers / Gatekeepers
 *   Managers, Leads, Analysts, Associates — those who may influence or block
 *
 * Exclude: Non-Decision-Makers
 *   Admin, support, interns, advisors — unlikely to have purchasing authority
 */

import { queuedLLMCall } from './_core/llmQueue';
import { getProfile } from './agentConfig';

export type DecisionMakerTier = "Tier 1" | "Tier 2" | "Tier 3" | "Exclude";

export interface TierClassification {
  tier: DecisionMakerTier;
  priority: number;
  description: string;
  needsLLMClassification?: boolean; // true when regex couldn't confidently classify
}

/**
 * TIER 1: Budget Authority / Decision Makers
 * Makes final purchase decisions, controls budget, signs contracts.
 */
const TIER1_PATTERNS = [
  // C-suite (general B2B)
  "chief executive officer", "ceo",
  "chief technology officer", "cto",
  "chief financial officer", "cfo",
  "chief operating officer", "coo",
  "chief revenue officer", "cro",
  "chief marketing officer", "cmo",
  "chief product officer", "cpo",
  "chief information officer", "cio",
  "chief information security officer", "ciso",
  "chief people officer",
  "chief human resources officer", "chro",
  "chief commercial officer",
  "chief data officer", "cdo",
  "chief security officer", "cso",
  "chief growth officer",
  "chief strategy officer",
  "chief legal officer",
  "chief compliance officer",
  "chief customer officer",

  // Founder / Owner
  "founder",
  "co-founder", "cofounder",
  "owner", "co-owner",

  // Executive leadership
  "president",
  "executive director",
  "managing director", "md",
  "general manager",
  "chairman", "chairwoman", "chairperson",

  // Senior partner titles (professional services + VC)
  "managing partner",
  "general partner",
  "founding partner",
  "senior partner",
  "equity partner",
  "investment partner",

  // "partner" alone — handled with exclusion check in classifyDecisionMakerTier
  "partner",
];

/**
 * TIER 2: Senior Influencers / Champions
 * Leads purchasing processes, creates shortlists, drives internal decisions.
 */
const TIER2_PATTERNS = [
  // VP titles
  "vice president", "vp", "vice-president",

  // Director — catch-all: "Director of X", "Marketing Director", etc.
  "director",

  // Head of — catch-all: "Head of Marketing", "Head of Engineering", etc.
  "head of",

  // Senior / leadership variants
  "senior director", "sr. director", "sr director",
  "senior manager", "sr. manager", "sr manager",

  // Principal (senior individual contributor or partner-level in services)
  "principal",

  // Chief of Staff (executive-level influence)
  "chief of staff",

  // Controller (financial decision maker — distinct from "fund controller" which is excluded)
  "controller",

  // Senior associates (investment + general)
  "senior associate", "sr associate", "sr. associate",

  // Investment-specific Tier 2 (retained for VC compatibility)
  "investment manager", "senior investment manager",
  "investor relations", "ir partner",
  "head of investor relations",
];

/**
 * TIER 3: Junior Influencers / Gatekeepers
 * May influence or block the deal but don't have final authority.
 */
const TIER3_PATTERNS = [
  // Manager — catch-all: "Marketing Manager", "Product Manager", etc.
  "manager",

  // Team lead variants
  "team lead", "team leader",

  // Lead — as standalone or in titles: "Engineering Lead", "Marketing Lead"
  "lead",

  // Associate (general + VC-specific)
  "associate",
  "investment associate", "venture associate",

  // Analyst (general + VC-specific)
  "analyst",
  "investment analyst", "venture analyst", "business analyst",

  // Specialist
  "specialist",

  // Supervisor
  "supervisor",
];

/**
 * EXCLUDE: Non-Decision-Makers
 * Administrative, support, non-employee, or post-investment roles.
 * Note: broad functional terms (marketing, hr, finance) are intentionally NOT
 * excluded here — rank patterns above handle "Director of HR" (Tier 2) vs
 * "HR Coordinator" (Tier 3 via manager → Exclude via coordinator).
 */
const EXCLUDE_PATTERNS = [
  // Administrative / Support
  "intern", "internship",
  "coordinator",
  "administrative assistant", "admin assistant",
  "executive assistant",
  "receptionist", "secretary",
  "community manager",
  "accelerator manager",
  "program associate", "program coordinator",

  // Data / Technical operational (not typical buyers)
  "data engineer",
  "investment data analyst",

  // Pure legal / compliance specialists
  "legal counsel", "general counsel",
  "attorney", "paralegal",
  "compliance analyst", "compliance associate",

  // Pure accounting operational
  "bookkeeper",
  "fund accountant", "fund controller", "fund administrator",
  "treasurer",

  // VC-specific non-deal roles
  "limited partner", " lp ",
  "angel investor",
  "operating partner",
  "venture partner",
  "strategic partner",
  "executive partner",
  "entrepreneur in residence", "eir",

  // Portfolio / post-investment (VC)
  "portfolio manager",
  "portfolio director",
  "portfolio operations",
  "portfolio manger", // common typo
  "investment operations",

  // Non-employee relationships
  "advisor", "adviser",
  "consultant",
  "board member", "board observer",
  "fellow", "scholar",

  // Channel / ecosystem partner (external party, not employee decision maker)
  "channel partner",
  "technology partner",
  "reseller partner",
];

/**
 * Compound titles that must be excluded even though they contain words that
 * appear in tier patterns (e.g. "fund controller" contains "controller" which
 * is Tier 2). Checked before tier patterns to prevent false positives.
 */
const PRE_TIER_EXCLUSIONS = [
  // Excluded partner types (contain "partner" which is Tier 1)
  "operating partner",
  "venture partner",
  "limited partner",
  "strategic partner",
  "executive partner",
  "channel partner",
  "technology partner",
  "reseller partner",

  // Excluded finance ops roles (contain "controller/manager" which are Tier 2/3)
  "fund controller",
  "fund manager",
  "fund administrator",
  "portfolio manager",
  "portfolio director",
];

// ---------------------------------------------------------------------------
// Profile-sourced pattern getters (prefer profile, fall back to hardcoded)
// ---------------------------------------------------------------------------

function getTierPatterns() {
  const tp = getProfile().tierPatterns;
  return {
    tier1: tp.tier1.length > 0 ? tp.tier1 : TIER1_PATTERNS,
    tier2: tp.tier2.length > 0 ? tp.tier2 : TIER2_PATTERNS,
    tier3: tp.tier3.length > 0 ? tp.tier3 : TIER3_PATTERNS,
    exclude: tp.exclude.length > 0 ? tp.exclude : EXCLUDE_PATTERNS,
    preTierExclusions: tp.pre_tier_exclusions.length > 0 ? tp.pre_tier_exclusions : PRE_TIER_EXCLUSIONS,
  };
}

/**
 * Check if title matches any pattern (case-insensitive, whole-word matching).
 */
function matchesPattern(title: string, patterns: string[]): boolean {
  const titleLower = title.toLowerCase().trim();

  return patterns.some(pattern => {
    const patternLower = pattern.toLowerCase();

    // Exact match
    if (titleLower === patternLower) return true;

    // Word boundary match
    const escaped = patternLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`);
    return regex.test(titleLower);
  });
}

/**
 * Synchronously classify a job title into a decision maker tier using regex patterns.
 *
 * When `needsLLMClassification` is true on the result, callers that support async
 * can call `classifyDecisionMakerTierWithLLM()` for a more accurate result.
 */
export function classifyDecisionMakerTier(title: string): TierClassification {
  if (!title || title.trim().length === 0) {
    return {
      tier: "Tier 3",
      priority: 3,
      description: "Unknown role (empty title) — defaulting to junior",
    };
  }

  const titleLower = title.toLowerCase().trim();

  // Get patterns from profile (or fallback to hardcoded)
  const tp = getTierPatterns();

  // Exclude compound titles before any tier patterns (e.g. "fund controller" before "controller" in Tier 2)
  if (matchesPattern(title, tp.preTierExclusions)) {
    return {
      tier: "Exclude",
      priority: 999,
      description: "Non-decision-making partner / external relationship role",
    };
  }

  // TIER 1: Budget authority / decision makers
  if (matchesPattern(titleLower, tp.tier1)) {
    // Special case: "partner" alone — verify it's not an excluded partner type
    if (titleLower === "partner") {
      // Already passed the excluded partner types check above, so this is a legitimate partner
      return {
        tier: "Tier 1",
        priority: 1,
        description: "Partner — budget authority / decision maker",
      };
    }

    return {
      tier: "Tier 1",
      priority: 1,
      description: "Budget authority / decision maker",
    };
  }

  // TIER 2: Senior influencers / champions
  if (matchesPattern(titleLower, tp.tier2)) {
    return {
      tier: "Tier 2",
      priority: 2,
      description: "Senior influencer / champion",
    };
  }

  // TIER 3: Junior influencers / gatekeepers
  if (matchesPattern(titleLower, tp.tier3)) {
    return {
      tier: "Tier 3",
      priority: 3,
      description: "Junior influencer / gatekeeper",
    };
  }

  // EXCLUDE: Non-decision-making roles
  if (matchesPattern(titleLower, tp.exclude)) {
    return {
      tier: "Exclude",
      priority: 999,
      description: "Non-decision-making / administrative / support role",
    };
  }

  // Unknown — flag for LLM classification; default to Tier 3 so nothing is lost
  console.log(`[Tier Classifier] Unknown title, LLM classification recommended: "${title}"`);
  return {
    tier: "Tier 3",
    priority: 3,
    description: "Unknown role — LLM classification recommended",
    needsLLMClassification: true,
  };
}

/**
 * Async version that falls back to LLM for titles the regex couldn't confidently classify.
 * Use this in contexts where accuracy matters more than speed (e.g. post-extraction enrichment pass).
 *
 * @param title - The job title to classify
 * @param companyName - Optional company name for better LLM context
 */
export async function classifyDecisionMakerTierWithLLM(
  title: string,
  companyName?: string,
): Promise<TierClassification> {
  const syncResult = classifyDecisionMakerTier(title);

  // Only call LLM when regex was uncertain
  if (!syncResult.needsLLMClassification) {
    return syncResult;
  }

  try {
    const contextLine = companyName
      ? `Title: "${title}" at ${companyName}`
      : `Title: "${title}"`;

    const result = await queuedLLMCall({
      messages: [
        {
          role: "system",
          content:
            "You are a B2B sales intelligence assistant. Classify job titles for outreach targeting. Respond with JSON only.",
        },
        {
          role: "user",
          content:
            `${contextLine}\n\nClassify as exactly one of:\n` +
            `- Tier 1: Budget authority / final decision maker (C-suite, founder, owner, managing director, partner)\n` +
            `- Tier 2: Senior influencer / champion (VP, Director, Head of department, senior manager)\n` +
            `- Tier 3: Junior influencer / gatekeeper (manager, lead, analyst, associate, specialist)\n` +
            `- Exclude: No purchasing influence (admin, intern, receptionist, coordinator, advisor, non-employee)\n\n` +
            `JSON only: {"tier": "Tier 1" | "Tier 2" | "Tier 3" | "Exclude"}`,
        },
      ],
      responseFormat: { type: "json_object" },
      maxTokens: 50,
    });

    const content = result.choices?.[0]?.message?.content;
    if (typeof content === "string") {
      const parsed = JSON.parse(content);
      const tier = parsed.tier as DecisionMakerTier;
      if (["Tier 1", "Tier 2", "Tier 3", "Exclude"].includes(tier)) {
        const priorityMap: Record<DecisionMakerTier, number> = {
          "Tier 1": 1,
          "Tier 2": 2,
          "Tier 3": 3,
          "Exclude": 999,
        };
        return {
          tier,
          priority: priorityMap[tier],
          description: `LLM-classified: ${tier}`,
        };
      }
    }
  } catch (err) {
    console.warn(`[Tier Classifier] LLM fallback failed for "${title}":`, err);
  }

  // LLM failed — return the sync default (Tier 3)
  return syncResult;
}

/**
 * Filter team members to only include decision makers (Tier 1-3 by default).
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
 * Sort team members by decision-making priority (Tier 1 first).
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
