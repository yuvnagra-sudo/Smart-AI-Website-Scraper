/**
 * Cost Estimation for VC Enrichment
 * Calculates estimated API costs based on firm count and enrichment depth
 */

export interface CostEstimate {
  totalCost: number;
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
 * Pricing (based on gpt-4o-mini rates)
 * Input: $0.15 per 1M tokens
 * Output: $0.60 per 1M tokens
 */
const PRICING = {
  inputPer1M: 0.15,
  outputPer1M: 0.60,
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
 * Estimate enrichment cost for a given number of firms
 */
export function estimateEnrichmentCost(firmCount: number): CostEstimate {
  // Base operations (always performed)
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

  const teamMembersCost = calculateOperationCost(
    TOKEN_ESTIMATES.teamMembers.input,
    TOKEN_ESTIMATES.teamMembers.output,
  );

  const portfolioCost = calculateOperationCost(
    TOKEN_ESTIMATES.portfolioCompanies.input,
    TOKEN_ESTIMATES.portfolioCompanies.output,
  );

  // Waterfall enrichment (assume 30% of firms need it, with 2 retries average)
  const waterfallCost = calculateOperationCost(
    TOKEN_ESTIMATES.waterfallRetry.input,
    TOKEN_ESTIMATES.waterfallRetry.output,
  ) * 2 * 0.3; // 2 retries * 30% of firms

  // Per-firm cost
  const perFirmCost =
    verificationCost +
    investorTypeCost +
    investmentStagesCost +
    nichesCost +
    teamMembersCost +
    portfolioCost +
    waterfallCost;

  // Total cost
  const totalCost = perFirmCost * firmCount;

  // Token estimates
  const inputTokensPerFirm =
    TOKEN_ESTIMATES.websiteVerification.input +
    TOKEN_ESTIMATES.investorType.input +
    TOKEN_ESTIMATES.investmentStages.input +
    TOKEN_ESTIMATES.niches.input +
    TOKEN_ESTIMATES.teamMembers.input +
    TOKEN_ESTIMATES.portfolioCompanies.input +
    TOKEN_ESTIMATES.waterfallRetry.input * 2 * 0.3;

  const outputTokensPerFirm =
    TOKEN_ESTIMATES.websiteVerification.output +
    TOKEN_ESTIMATES.investorType.output +
    TOKEN_ESTIMATES.investmentStages.output +
    TOKEN_ESTIMATES.niches.output +
    TOKEN_ESTIMATES.teamMembers.output +
    TOKEN_ESTIMATES.portfolioCompanies.output +
    TOKEN_ESTIMATES.waterfallRetry.output * 2 * 0.3;

  // Duration estimate (updated based on actual processing times)
  // Portfolio extraction alone takes ~20s, full enrichment takes 60-90s per firm
  // Processing happens sequentially due to rate limits and browser operations
  const secondsPerFirm = 75; // More realistic estimate
  const totalSeconds = secondsPerFirm * firmCount;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const estimatedDuration = hours > 0 
    ? `${hours}h ${minutes}m` 
    : minutes > 0 
      ? `${minutes}m`
      : `${Math.ceil(totalSeconds / 60)}m`;

  return {
    totalCost: Math.round(totalCost * 100) / 100,
    perFirmCost: Math.round(perFirmCost * 10000) / 10000,
    breakdown: {
      websiteVerification: Math.round(verificationCost * firmCount * 100) / 100,
      investorTypeExtraction: Math.round(investorTypeCost * firmCount * 100) / 100,
      investmentStagesExtraction: Math.round(investmentStagesCost * firmCount * 100) / 100,
      nichesExtraction: Math.round(nichesCost * firmCount * 100) / 100,
      teamMemberExtraction: Math.round(teamMembersCost * firmCount * 100) / 100,
      portfolioExtraction: Math.round(portfolioCost * firmCount * 100) / 100,
      waterfallEnrichment: Math.round(waterfallCost * firmCount * 100) / 100,
    },
    estimatedTokens: {
      input: Math.round(inputTokensPerFirm * firmCount),
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
