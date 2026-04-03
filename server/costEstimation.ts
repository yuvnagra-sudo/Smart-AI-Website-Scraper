/**
 * Cost Estimation for Agent-Loop Enrichment
 *
 * Models the actual agent loop structure:
 *   per firm = AVG_HOPS × (planNextAction call + extractProfileFields call)
 *            × PRE_LLM_SKIP_RATE (pre-LLM extraction skips some LLM calls)
 *
 * Uses the active profile's model selection (gpt-5-nano by default) for pricing.
 * Pre-LLM extraction handles ~30-50% of fields deterministically, reducing
 * the number and size of LLM calls.
 *
 * planNextAction:       ~2000 input + 100 output tokens (decision prompt + field state)
 * extractProfileFields: scales with page content and remaining sections after pre-LLM
 */

import { getProfile } from "./agentConfig";

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

/** Tokens for one planNextAction call (~2K input: prompt + field state + links). */
const PLAN_INPUT_TOKENS  = 2000;
const PLAN_OUTPUT_TOKENS = 100;

/**
 * Tokens for one extractProfileFields call.
 * Base is the page content (~4K tokens average after pre-LLM reduces section count).
 * Each section adds ~50 input tokens to the prompt and ~25 output tokens.
 * Pre-LLM extraction handles ~30-50% of sections, so effective sections are lower.
 */
const EXTRACT_INPUT_BASE           = 4000;
const EXTRACT_INPUT_PER_SECTION    = 50;
const EXTRACT_OUTPUT_BASE          = 200;
const EXTRACT_OUTPUT_PER_SECTION   = 25;

/**
 * Average hops per firm. Failed fetches no longer waste hops (hop counter
 * increments after success check), so effective hops are lower than before.
 * Primary page = 1 hop + ~2 agent hops on average.
 */
const AVG_HOPS = 3;

/**
 * Fraction of hops where pre-LLM extraction fills ALL remaining fields,
 * allowing the LLM extraction call to be skipped entirely.
 * Observed on sites with good JSON-LD/CSS structure: ~20-30%.
 */
const PRE_LLM_FULL_SKIP_RATE = 0.25;

// ---------------------------------------------------------------------------
// Pricing — uses the active profile's model selection
// ---------------------------------------------------------------------------

/** OpenAI model pricing (per 1M tokens) */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-5-nano":   { input: 0.05,  output: 0.40  },
  "gpt-5-mini":   { input: 0.25,  output: 2.00  },
  "gpt-5":        { input: 1.25,  output: 10.00 },
  "gpt-4.1-nano": { input: 0.10,  output: 0.40  },
  "gpt-4.1-mini": { input: 0.40,  output: 1.60  },
  "gpt-4o-mini":  { input: 0.15,  output: 0.60  },
};

function getModelPricing(model: string): { input: number; output: number } {
  return MODEL_PRICING[model] ?? MODEL_PRICING["gpt-5-nano"];
}

function calculateCost(inputTokens: number, outputTokens: number, model: string): number {
  const p = getModelPricing(model);
  return (inputTokens / 1_000_000) * p.input
       + (outputTokens / 1_000_000) * p.output;
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
  const profile = getProfile();
  const planModel = profile.planningModel;
  const extractModel = profile.extractionModel;

  // Content scale: richer sites have larger pages → more input tokens per extract call.
  // Clamped to [0.7, 2.0] to avoid extreme estimates.
  const contentScale = Math.min(2.0, Math.max(0.7, avgDescriptionLength / 200));

  // Pre-LLM reduces effective section count by ~30-50% (those fields extracted deterministically)
  const effectiveSections = Math.ceil(sectionCount * 0.65);

  // Per-hop cost
  const planCostPerHop = calculateCost(PLAN_INPUT_TOKENS, PLAN_OUTPUT_TOKENS, planModel);
  const scaledExtractInput  = (EXTRACT_INPUT_BASE + effectiveSections * EXTRACT_INPUT_PER_SECTION) * contentScale;
  const scaledExtractOutput =  EXTRACT_OUTPUT_BASE + effectiveSections * EXTRACT_OUTPUT_PER_SECTION;
  // Account for hops where pre-LLM fills all fields and LLM call is skipped
  const extractCostPerHop = calculateCost(scaledExtractInput, scaledExtractOutput, extractModel) * (1 - PRE_LLM_FULL_SKIP_RATE);

  // Per-firm cost (midpoint)
  const planCostPerFirm    = AVG_HOPS * planCostPerHop;
  const extractCostPerFirm = AVG_HOPS * extractCostPerHop;
  const perFirmCost        = planCostPerFirm + extractCostPerFirm;

  // Total cost (midpoint)
  const totalCost = perFirmCost * firmCount;

  // Variance: fewer/more hops and page sizes vary ±60%
  const variance = 0.60;
  const totalCostLow  = Math.round(totalCost * (1 - variance) * 100) / 100;
  const totalCostHigh = Math.round(totalCost * (1 + variance) * 100) / 100;

  // Token totals (for display — approximate)
  const inputTokensPerFirm  = AVG_HOPS * (PLAN_INPUT_TOKENS + scaledExtractInput * (1 - PRE_LLM_FULL_SKIP_RATE));
  const outputTokensPerFirm = AVG_HOPS * (PLAN_OUTPUT_TOKENS + scaledExtractOutput * (1 - PRE_LLM_FULL_SKIP_RATE));

  // Duration estimate — 50 concurrent workers at 8,000 RPM (OpenAI Tier 4)
  // LLM calls per firm: planNextAction + extractProfileFields per hop (minus skips)
  const llmCallsPerFirm = AVG_HOPS * (1 + (1 - PRE_LLM_FULL_SKIP_RATE));
  const rpm = parseInt(process.env.LLM_RPM_LIMIT ?? "8000", 10);
  const llmSeconds      = (firmCount * llmCallsPerFirm) / (rpm / 60);
  const scrapingSeconds = Math.ceil(firmCount / 50) * 20;
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
