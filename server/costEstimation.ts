/**
 * Cost Estimation for Agent-Loop Enrichment
 *
 * Models the actual agent loop structure:
 *   per firm = AVG_HOPS × (planNextAction call + extractProfileFields call)
 *
 * planNextAction:   ~800 input + 100 output tokens (fixed, just the decision prompt)
 * extractProfileFields: scales with page content size and number of sections
 */

export interface CostEstimate {
  totalCost: number;
  totalCostLow: number;   // low end of range (lean sites, fewer hops)
  totalCostHigh: number;  // high end of range (content-rich sites, more hops)
  perFirmCost: number;
  breakdown: {
    planningCost: number;     // planNextAction LLM calls
    extractionCost: number;   // extractProfileFields LLM calls
  };
  estimatedTokens: {
    input: number;
    output: number;
  };
  estimatedDuration: string;
}

// ---------------------------------------------------------------------------
// Agent loop token constants (based on observed averages)
// ---------------------------------------------------------------------------

/** Tokens for one planNextAction call (the decision prompt is ~800 tokens in, ~100 out). */
const PLAN_INPUT_TOKENS  = 800;
const PLAN_OUTPUT_TOKENS = 100;

/**
 * Tokens for one extractProfileFields call.
 * Base is the page content (typically 5,000–8,000 tokens for a company homepage).
 * Each additional section adds ~50 input tokens to the prompt and ~20 output tokens.
 */
const EXTRACT_INPUT_BASE           = 6000;
const EXTRACT_INPUT_PER_SECTION    = 50;
const EXTRACT_OUTPUT_BASE          = 250;
const EXTRACT_OUTPUT_PER_SECTION   = 25;

/** Average hops per firm across all jobs (primary page counts as hop 0 + ~2.5 agent hops). */
const AVG_HOPS = 3.5;

// ---------------------------------------------------------------------------
// Pricing — dynamic based on active provider
// ---------------------------------------------------------------------------

const USE_GEMINI = !!process.env.GEMINI_API_KEY;
const PRICING = {
  inputPer1M:  USE_GEMINI ? 0.075 : 0.15,
  outputPer1M: USE_GEMINI ? 0.30  : 0.60,
};

function calculateCost(inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1_000_000) * PRICING.inputPer1M
       + (outputTokens / 1_000_000) * PRICING.outputPer1M;
}

// ---------------------------------------------------------------------------
// Main estimation function
// ---------------------------------------------------------------------------

/**
 * Estimate enrichment cost for a given number of firms.
 *
 * @param firmCount - Number of firms to process
 * @param sectionCount - Number of extraction sections (affects extraction token cost)
 * @param avgDescriptionLength - Average character length of descriptions in the
 *   uploaded file. Longer descriptions signal content-rich sites → more scraped
 *   content per page → higher extraction token cost.
 */
export function estimateEnrichmentCost(
  firmCount: number,
  sectionCount = 6,
  avgDescriptionLength = 200,
): CostEstimate {
  // Content scale: richer sites have larger pages → more input tokens per extract call.
  // Clamped to [0.7, 2.5] to avoid extreme estimates for very bare or very long descriptions.
  const contentScale = Math.min(2.5, Math.max(0.7, avgDescriptionLength / 200));

  // Per-hop cost
  const planCostPerHop = calculateCost(PLAN_INPUT_TOKENS, PLAN_OUTPUT_TOKENS);
  const scaledExtractInput  = (EXTRACT_INPUT_BASE  + sectionCount * EXTRACT_INPUT_PER_SECTION)  * contentScale;
  const scaledExtractOutput =  EXTRACT_OUTPUT_BASE + sectionCount * EXTRACT_OUTPUT_PER_SECTION;
  const extractCostPerHop = calculateCost(scaledExtractInput, scaledExtractOutput);

  // Per-firm cost (midpoint)
  const planCostPerFirm    = AVG_HOPS * planCostPerHop;
  const extractCostPerFirm = AVG_HOPS * extractCostPerHop;
  const perFirmCost        = planCostPerFirm + extractCostPerFirm;

  // Total cost (midpoint)
  const totalCost = perFirmCost * firmCount;

  // Variance: fewer/more hops and page sizes vary ±50%
  const variance = 0.50;
  const totalCostLow  = Math.round(totalCost * (1 - variance) * 100) / 100;
  const totalCostHigh = Math.round(totalCost * (1 + variance) * 100) / 100;

  // Token totals
  const inputTokensPerFirm  = AVG_HOPS * (PLAN_INPUT_TOKENS  + scaledExtractInput);
  const outputTokensPerFirm = AVG_HOPS * (PLAN_OUTPUT_TOKENS + scaledExtractOutput);

  // Duration estimate — 50 concurrent workers at 1,000 RPM (Gemini Tier 2)
  // LLM bottleneck: firmCount × AVG_HOPS × 2 calls / (1000 RPM / 60) seconds
  // Scraping bottleneck: ceil(firmCount / 50) × 25s per batch
  const llmSeconds      = (firmCount * AVG_HOPS * 2) / (1000 / 60);
  const scrapingSeconds = Math.ceil(firmCount / 50) * 25;
  const totalSeconds    = Math.max(llmSeconds, scrapingSeconds);
  const hours   = Math.floor(totalSeconds / 3600);
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
      planningCost:   Math.round(planCostPerFirm    * firmCount * 100) / 100,
      extractionCost: Math.round(extractCostPerFirm * firmCount * 100) / 100,
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
