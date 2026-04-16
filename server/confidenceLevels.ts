/**
 * Standardized Confidence Levels
 *
 * Used across all extraction methods so confidence scores are
 * comparable and merge logic picks the right data.
 */
export const CONFIDENCE = {
  VERIFIED: 0.90,    // Data from verified external API (Hunter verified email, SMTP confirmed)
  EXTRACTED: 0.70,   // Data directly extracted from page (regex match, JSON-LD, mailto: link)
  INFERRED: 0.50,    // Data inferred by LLM or pattern matching (smart URL, context matching)
  UNVERIFIED: 0.30,  // Data exists but not validated (rate-limited LinkedIn check, name-only match)
} as const;
