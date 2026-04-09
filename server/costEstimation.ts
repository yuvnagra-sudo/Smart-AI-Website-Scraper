/**
 * Cost Estimation for Super Scraper v2
 *
 * The super scraper uses a 6-phase escalation model with model tiering:
 *   - Phase 1: LLM URL picker (nano)              ~$0.0003/firm
 *   - Phase 2: Deterministic extraction            $0.00
 *   - Phase 3: Targeted LLM extraction (nano)      ~$0.0015/firm (80% of firms)
 *   - Phase 4: Agentic escalation (mini+nano)      ~$0.01/firm (20% of firms)
 *   - Phase 5: Validation + consolidation (nano)   ~$0.0005/firm
 *   - Phase 6: Hunter.io + SMTP                    ~$0.01/firm (if HUNTER_API_KEY set)
 *
 * All estimates are inflated 2.5x to account for real-world variance
 * (retries, large pages, complex sites, multiple search queries).
 */

export interface CostEstimate {
  totalCost: number;
  totalCostLow: number;
  totalCostHigh: number;
  perFirmCost: number;
  breakdown: {
    urlDiscovery: number;         // Phase 1 LLM URL picker
    llmExtraction: number;        // Phase 3 targeted extraction
    agenticEscalation: number;    // Phase 4 (20% of firms)
    validationConsolidation: number; // Phase 5a+5b
    hunterEnrichment: number;     // Phase 6 Hunter.io
    smtpVerification: number;     // Phase 6 SMTP (free)
  };
  estimatedTokens: {
    input: number;
    output: number;
  };
  estimatedDuration: string;
}

/**
 * Per-firm cost components for Super Scraper v2.
 *
 * Model pricing:
 *   gpt-5.4-nano: $0.20 input / $0.80 output per 1M tokens
 *   gpt-5.4-mini: $0.75 input / $3.00 output per 1M tokens
 *
 * All token estimates are averages from observed runs, then multiplied
 * by a 2.5x safety factor so the user is never surprised by the bill.
 */
const SAFETY_MULTIPLIER = 2.5;

const NANO_PRICING  = { inputPer1M: 0.20, outputPer1M: 0.80 };
const MINI_PRICING  = { inputPer1M: 0.75, outputPer1M: 3.00 };

function llmCost(
  inputTokens: number,
  outputTokens: number,
  pricing: { inputPer1M: number; outputPer1M: number },
): number {
  return (inputTokens / 1_000_000) * pricing.inputPer1M
       + (outputTokens / 1_000_000) * pricing.outputPer1M;
}

// Hunter.io costs $0.01 per domain search (1 credit on Growth plan)
const HUNTER_COST_PER_CALL = 0.01;
const HUNTER_ENABLED = !!process.env.HUNTER_API_KEY;

/**
 * Estimate enrichment cost for a given number of firms.
 *
 * @param firmCount - Number of firms to process
 * @param avgDescriptionLength - Average description length (unused in super scraper but kept for API compat)
 */
export function estimateEnrichmentCost(
  firmCount: number,
  avgDescriptionLength = 200,
): CostEstimate {
  // ── Phase 1: LLM URL picker (nano, 1 call per firm) ──
  // ~1000 input tokens (URL list), ~100 output tokens (picks)
  const phase1CostPerFirm = llmCost(1000, 100, NANO_PRICING);

  // ── Phase 3: Targeted extraction (80% of firms need this) ──
  // Uses mini for analytical/judgment fields, nano for data-only fields.
  // ~5000 input tokens (5 preprocessed pages), ~500 output tokens (structured JSON)
  // Assume ~60% of sections are analytical → 60% mini, 40% nano pricing
  const phase3NanoCost = llmCost(5000, 500, NANO_PRICING) * 0.4;
  const phase3MiniCost = llmCost(5000, 500, MINI_PRICING) * 0.6;
  const phase3CostPerFirm = (phase3NanoCost + phase3MiniCost) * 0.8;

  // ── Phase 4: Agentic escalation (50% of firms, avg 4 LLM calls per hop, 3 hops avg) ──
  // Many real-world sites are sparse — assume half escalate to the agent loop.
  // Per hop: 1 planning call (mini) + 1 extraction call (nano)
  // Average 3 hops × (planning + extraction) = 6 LLM calls
  const phase4PlanningCost = llmCost(800, 200, MINI_PRICING) * 3;   // 3 planning calls
  const phase4ExtractionCost = llmCost(3000, 400, NANO_PRICING) * 3; // 3 extraction calls
  const phase4CostPerFirm = (phase4PlanningCost + phase4ExtractionCost) * 0.5;

  // ── Phase 5a: Validation (nano, 1 call per firm) ──
  // ~300 input tokens (just extracted fields), ~100 output tokens
  const phase5aCostPerFirm = llmCost(300, 100, NANO_PRICING);

  // ── Phase 5b: Final consolidation (nano, ~50% of firms still have gaps) ──
  // ~5000 input tokens, ~500 output tokens
  const phase5bCostPerFirm = llmCost(5000, 500, NANO_PRICING) * 0.5;

  // ── Phase 6: Hunter.io (if enabled, ~60% of firms need email lookup) ──
  const hunterCostPerFirm = HUNTER_ENABLED ? HUNTER_COST_PER_CALL * 0.6 : 0;

  // ── Phase 6: SMTP (free) ──
  const smtpCostPerFirm = 0;

  // ── Raw per-firm cost ──
  const rawPerFirmCost =
    phase1CostPerFirm +
    phase3CostPerFirm +
    phase4CostPerFirm +
    phase5aCostPerFirm +
    phase5bCostPerFirm +
    hunterCostPerFirm +
    smtpCostPerFirm;

  // Apply 2.5x safety multiplier to LLM costs (not Hunter — that's a fixed API price)
  const llmPerFirmCost = (
    phase1CostPerFirm +
    phase3CostPerFirm +
    phase4CostPerFirm +
    phase5aCostPerFirm +
    phase5bCostPerFirm
  ) * SAFETY_MULTIPLIER;

  const perFirmCost = llmPerFirmCost + hunterCostPerFirm + smtpCostPerFirm;
  const totalCost = perFirmCost * firmCount;

  // Cost range — ±40% (easy sites are much cheaper, hard sites hit Phase 4 heavily)
  const totalCostLow  = Math.round(totalCost * 0.6 * 100) / 100;
  const totalCostHigh = Math.round(totalCost * 1.4 * 100) / 100;

  // ── Token estimates (with safety multiplier) ──
  const inputTokensPerFirm = (
    1000 +           // Phase 1
    5000 * 0.8 +     // Phase 3
    (800 * 3 + 3000 * 3) * 0.5 + // Phase 4 (3 hops × planning + extraction, 50% of firms)
    300 +            // Phase 5a
    5000 * 0.5       // Phase 5b
  ) * SAFETY_MULTIPLIER;

  const outputTokensPerFirm = (
    100 +            // Phase 1
    500 * 0.8 +      // Phase 3
    (200 * 3 + 400 * 3) * 0.5 + // Phase 4
    100 +            // Phase 5a
    500 * 0.5        // Phase 5b
  ) * SAFETY_MULTIPLIER;

  // ── Duration estimate ──
  // Super scraper: ~15-45s per firm (parallel fetch + LLM calls)
  // 50 concurrent workers, but LLM queue is shared
  // LLM bottleneck: (firmCount × 6 avg calls) / (1000 RPM / 60) seconds
  // Scraping bottleneck: ceil(firmCount / 50) × 30s per batch
  const llmSeconds      = (firmCount * 6) / (1000 / 60);
  const scrapingSeconds = Math.ceil(firmCount / 50) * 30;
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
      urlDiscovery:             Math.round(phase1CostPerFirm  * SAFETY_MULTIPLIER * firmCount * 100) / 100,
      llmExtraction:            Math.round(phase3CostPerFirm  * SAFETY_MULTIPLIER * firmCount * 100) / 100,
      agenticEscalation:        Math.round(phase4CostPerFirm  * SAFETY_MULTIPLIER * firmCount * 100) / 100,
      validationConsolidation:  Math.round((phase5aCostPerFirm + phase5bCostPerFirm) * SAFETY_MULTIPLIER * firmCount * 100) / 100,
      hunterEnrichment:         Math.round(hunterCostPerFirm  * firmCount * 100) / 100,
      smtpVerification:         0,
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
