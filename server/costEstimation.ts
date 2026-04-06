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
 * extractProfileFields: ~15000 input tokens (actual 60K char page ÷ 4 chars/token)
 *                       + ~600 output tokens (CoT scratchpad + JSON)
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
// Agent loop token constants (calibrated to actual observed usage)
// ---------------------------------------------------------------------------

/** Tokens for one planNextAction call (~2K input: prompt + field state + links). */
const PLAN_INPUT_TOKENS  = 2_000;
const PLAN_OUTPUT_TOKENS = 100;

/**
 * Tokens for one extractProfileFields call.
 *
 * EXTRACT_INPUT_BASE: The page content is truncated at 60,000 characters before
 * being sent to the LLM. At ~4 characters per token, that is ~15,000 tokens.
 * This is the dominant cost driver — not the section count.
 *
 * EXTRACT_OUTPUT_BASE: The Chain-of-Thought scratchpad adds ~400 tokens before
 * the JSON output (~200 tokens), giving ~600 total output tokens per call.
 *
 * Each section adds ~50 input tokens (field description in the prompt) and
 * ~25 output tokens (the extracted JSON value).
 */
const EXTRACT_INPUT_BASE         = 15_000;   // actual 60K char page ÷ 4 chars/token
const EXTRACT_INPUT_PER_SECTION  = 50;
const EXTRACT_OUTPUT_BASE        = 600;      // CoT scratchpad (~400) + JSON (~200)
const EXTRACT_OUTPUT_PER_SECTION = 25;

/**
 * Average hops per firm. Primary page = 1 hop + ~2 agent hops on average.
 * With Fix 2 (top-3 search results), up to 3 pages per search hop, but
 * the loop stops early when all fields are confident, so effective hops
 * remain close to 3 on average.
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

/** OpenAI model pricing (per 1M tokens, Apr 2026) */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // GPT-5 family
  "gpt-5.4":      { input: 2.50,  output: 15.00 },
  "gpt-5.4-mini": { input: 0.25,  output: 2.00  },
  "gpt-5.2":      { input: 1.75,  output: 14.00 },
  "gpt-5.1":      { input: 1.25,  output: 10.00 },
  "gpt-5":        { input: 1.25,  output: 10.00 },
  "gpt-5-mini":   { input: 0.25,  output: 2.00  },
  "gpt-5-nano":   { input: 0.05,  output: 0.40  },  // ← default
  // GPT-4.1 family
  "gpt-4.1":      { input: 3.00,  output: 12.00 },
  "gpt-4.1-mini": { input: 0.40,  output: 1.60  },
  "gpt-4.1-nano": { input: 0.10,  output: 0.40  },
  // Legacy
  "gpt-4o":       { input: 2.50,  output: 10.00 },
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
  const planModel    = profile.planningModel;
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

  // Duration estimate
  // Concurrency: firms run in parallel up to the cap (200 for Tier 5, 50 for lower tiers)
  // LLM calls per firm: planNextAction + extractProfileFields per hop (minus skips)
  const rpm = parseInt(process.env.LLM_RPM_LIMIT ?? "8000", 10);
  // Concurrency cap: 200 for Tier 5 (24K RPM), 50 for Tier 4 (8K RPM)
  const concurrencyCap = rpm >= 20_000 ? 200 : 50;
  const llmCallsPerFirm = AVG_HOPS * (1 + (1 - PRE_LLM_FULL_SKIP_RATE));
  const llmSeconds      = (firmCount * llmCallsPerFirm) / (rpm / 60);
  const scrapingSeconds = Math.ceil(firmCount / concurrencyCap) * 20;
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
  return `Estimated cost: $${estimate.totalCostLow.toFixed(2)} – $${estimate.totalCostHigh.toFixed(2)} ($${estimate.perFirmCost.toFixed(4)} per firm)
Duration: ~${estimate.estimatedDuration}
Tokens: ${(estimate.estimatedTokens.input + estimate.estimatedTokens.output).toLocaleString()} total`;
}
