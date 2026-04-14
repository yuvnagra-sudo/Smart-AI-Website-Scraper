/**
 * Decision Maker Tier Classification (Generic)
 *
 * Stripped of all VC-specific hardcoded patterns.
 * All people are included by default — filtering and scoring
 * will be handled by AI based on outreach context, not rigid title matching.
 *
 * The tier field is preserved for backward compatibility with the database schema
 * and Excel output, but no longer drives filtering decisions.
 */

export type DecisionMakerTier = "Tier 1" | "Tier 2" | "Tier 3" | "Exclude";

export interface TierClassification {
  tier: DecisionMakerTier;
  priority: number;
  description: string;
}

/**
 * Classify a job title — returns all people as included (Tier 3) by default.
 * AI-based scoring will replace this in the pipeline.
 */
export function classifyDecisionMakerTier(title: string): TierClassification {
  if (!title || title.trim().length === 0) {
    return {
      tier: "Tier 3",
      priority: 3,
      description: "No title provided — included for AI scoring",
    };
  }

  // All people pass through — no hardcoded filtering
  return {
    tier: "Tier 3",
    priority: 3,
    description: "Included — awaiting AI-based relevance scoring",
  };
}

/**
 * Filter team members — returns ALL members (no filtering).
 * AI scoring will handle relevance determination.
 */
export function filterDecisionMakers<T extends { title: string }>(
  teamMembers: T[],
  _includeTiers: DecisionMakerTier[] = ["Tier 1", "Tier 2", "Tier 3"],
): T[] {
  return teamMembers;
}

/**
 * Sort team members — returns original order (no sorting by tier).
 * AI scoring will handle ranking.
 */
export function sortByDecisionMakingPriority<T extends { title: string }>(
  teamMembers: T[],
): T[] {
  return [...teamMembers];
}
