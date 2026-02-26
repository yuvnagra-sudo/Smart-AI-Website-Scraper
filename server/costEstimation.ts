/**
 * Cost Estimation for VC Enrichment
 * Calculates estimated API costs based on firm count and enrichment depth
 */

export interface CostEstimate {
  totalCost: number;
  totalCostLow: number;   // low end of range (lean sites)
  totalCostHigh: number;  // high end of range (data-rich sites)
  perFirmCost: number;
  breakdown: {
    websiteVerification: number;
    investorTypeExtraction: number;
    investmentStagesExtraction: number;
    nichesExtraction: number;
    teamMemberExtraction: number;
    portfolioExtraction: number;
    waterfallEnrichment: number;
  };
  estimatedTokens: {
    input: number;
    output: number;
  };
  estimatedDuration: string;
}

/**
 * Token estimates per operation (based on observed averages)
 * Updated to reflect new portfolio extraction with HTML parsing + LLM enrichment
 */
const TOKEN_ESTIMATES = {
  websiteVerification: { input: 500, output: 50 },
  investorType: { input: 1500, output: 100 },
  investmentStages: { input: 1500, output: 100 },
  niches: { input: 2000, output: 100 },
  teamMembers: { input: 3000, output: 800 }, // Increased: now scans entire page + footer
  portfolioCompanies: { input: 8000, output: 1500 }, // Significantly increased: HTML parsing + enrichment of ALL companies
  waterfallRetry: { input: 3000, output: 150 }, // Per retry attempt
};

/**
 * Pricing — dynamic based on active provider.
 * Gemini 2.5 Flash (when GEMINI_API_KEY is set): $0.075 input / $0.30 output per 1M tokens
 * gpt-4o-mini (default):                         $0.15  input / $0.60 output per 1M tokens
 */
const USE_GEMINI = !!process.env.GEMINI_API_KEY;
const PRICING = {
  inputPer1M:  USE_GEMINI ? 0.075 : 0.15,
  outputPer1M: USE_GEMINI ? 0.30  : 0.60,
};

/**
 * Calculate cost for a single operation
 */
function calculateOperationCost(inputTokens: number, outputTokens: number): number {
  const inputCost = (inputTokens / 1_000_000) * PRICING.inputPer1M;
  const outputCost = (outputTokens / 1_000_000) * PRICING.outputPer1M;
  return inputCost + outputCost;
}

/**
 * Estimate enrichment cost for a given number of firms.
 *
 * @param firmCount - Number of firms to process
 * @param avgDescriptionLength - Average character length of descriptions in the uploaded file.
 *   Longer descriptions signal content-rich sites (more pages, more team members, more portfolio data)
 *   and so predict higher actual token usage. Defaults to 200 chars (neutral baseline).
 */
export function estimateEnrichmentCost(
  firmCount: number,
  avgDescriptionLength = 200,
): CostEstimate {
  // Content scale: richer descriptions → more scraped content → more tokens.
  // Clamped to [0.7, 2.5] so we don't over-penalise bare-bones or extremely long descriptions.
  const contentScale = Math.min(2.5, Math.max(0.7, avgDescriptionLength / 200));

  // Scale the most variable operations (team + portfolio vary most with content depth)
  const scaledTeamInput      = TOKEN_ESTIMATES.teamMembers.input      * contentScale;
  const scaledTeamOutput     = TOKEN_ESTIMATES.teamMembers.output     * contentScale;
  const scaledPortfolioInput = TOKEN_ESTIMATES.portfolioCompanies.input  * contentScale;
  const scaledPortfolioOutput= TOKEN_ESTIMATES.portfolioCompanies.output * contentScale;

  // Base operations (always performed, not content-scaled)
  const verificationCost = calculateOperationCost(
    TOKEN_ESTIMATES.websiteVerification.input,
    TOKEN_ESTIMATES.websiteVerification.output,
  );

  const investorTypeCost = calculateOperationCost(
    TOKEN_ESTIMATES.investorType.input,
    TOKEN_ESTIMATES.investorType.output,
  );

  const investmentStagesCost = calculateOperationCost(
    TOKEN_ESTIMATES.investmentStages.input,
    TOKEN_ESTIMATES.investmentStages.output,
  );

  const nichesCost = calculateOperationCost(
    TOKEN_ESTIMATES.niches.input,
    TOKEN_ESTIMATES.niches.output,
  );

  const teamMembersCost  = calculateOperationCost(scaledTeamInput, scaledTeamOutput);
  const portfolioCost    = calculateOperationCost(scaledPortfolioInput, scaledPortfolioOutput);

  // Waterfall enrichment (assume 30% of firms need it, with 2 retries average)
  const waterfallCost = calculateOperationCost(
    TOKEN_ESTIMATES.waterfallRetry.input,
    TOKEN_ESTIMATES.waterfallRetry.output,
  ) * 2 * 0.3; // 2 retries * 30% of firms

  // Per-firm cost (midpoint)
  const perFirmCost =
    verificationCost +
    investorTypeCost +
    investmentStagesCost +
    nichesCost +
    teamMembersCost +
    portfolioCost +
    waterfallCost;

  // Total cost (midpoint)
  const totalCost = perFirmCost * firmCount;

  // Cost range — team + portfolio are the most variable operations (±45%)
  const varianceMultiplier = 0.45;
  const totalCostLow  = Math.round(totalCost * (1 - varianceMultiplier) * 100) / 100;
  const totalCostHigh = Math.round(totalCost * (1 + varianceMultiplier) * 100) / 100;

  // Token estimates
  const inputTokensPerFirm =
    TOKEN_ESTIMATES.websiteVerification.input +
    TOKEN_ESTIMATES.investorType.input +
    TOKEN_ESTIMATES.investmentStages.input +
    TOKEN_ESTIMATES.niches.input +
    scaledTeamInput +
    scaledPortfolioInput +
    TOKEN_ESTIMATES.waterfallRetry.input * 2 * 0.3;

  const outputTokensPerFirm =
    TOKEN_ESTIMATES.websiteVerification.output +
    TOKEN_ESTIMATES.investorType.output +
    TOKEN_ESTIMATES.investmentStages.output +
    TOKEN_ESTIMATES.niches.output +
    scaledTeamOutput +
    scaledPortfolioOutput +
    TOKEN_ESTIMATES.waterfallRetry.output * 2 * 0.3;

  // Duration estimate — 50 concurrent workers at 1,000 RPM Gemini Tier 2
  // LLM bottleneck: (firmCount × 6 calls) / (1000 RPM / 60) seconds
  // Scraping bottleneck: ceil(firmCount / 50) × 25s per batch
  // Wall-clock = max of the two (they run in parallel)
  const llmSeconds      = (firmCount * 6) / (1000 / 60);
  const scrapingSeconds = Math.ceil(firmCount / 50) * 25;
  const totalSeconds    = Math.max(llmSeconds, scrapingSeconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const estimatedDuration = hours > 0
    ? `${hours}h ${minutes}m`
    : minutes > 0
      ? `${minutes}m`
      : `<1m`;

  return {
    totalCost:     Math.round(totalCost * 100) / 100,
    totalCostLow,
    totalCostHigh,
    perFirmCost:   Math.round(perFirmCost * 10000) / 10000,
    breakdown: {
      websiteVerification:         Math.round(verificationCost    * firmCount * 100) / 100,
      investorTypeExtraction:      Math.round(investorTypeCost    * firmCount * 100) / 100,
      investmentStagesExtraction:  Math.round(investmentStagesCost* firmCount * 100) / 100,
      nichesExtraction:            Math.round(nichesCost          * firmCount * 100) / 100,
      teamMemberExtraction:        Math.round(teamMembersCost     * firmCount * 100) / 100,
      portfolioExtraction:         Math.round(portfolioCost       * firmCount * 100) / 100,
      waterfallEnrichment:         Math.round(waterfallCost       * firmCount * 100) / 100,
    },
    estimatedTokens: {
      input:  Math.round(inputTokensPerFirm  * firmCount),
      output: Math.round(outputTokensPerFirm * firmCount),
    },
    estimatedDuration,
  };
}

/**
 * Format cost estimate for display
 */
export function formatCostEstimate(estimate: CostEstimate): string {
  return `Estimated cost: $${estimate.totalCost.toFixed(2)} ($${estimate.perFirmCost.toFixed(4)} per firm)
Duration: ~${estimate.estimatedDuration}
Tokens: ${(estimate.estimatedTokens.input + estimate.estimatedTokens.output).toLocaleString()} total`;
}
