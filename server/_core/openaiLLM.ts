/**
 * LLM Implementation — Gemini primary, OpenAI gpt-4o-mini automatic fallback
 *
 * Provider selection:
 *   1. GEMINI_API_KEY set  → use Gemini (model: GEMINI_MODEL, default: gemini-3-flash-preview)
 *   2. GEMINI_API_KEY only → OpenAI fallback activates automatically on 429/quota exhaustion
 *   3. No GEMINI_API_KEY   → use OpenAI directly (OPENAI_API_KEY required)
 *
 * Fallback behaviour:
 *   When Gemini returns 429 RESOURCE_EXHAUSTED (daily RPD cap hit), invokeLLM()
 *   automatically retries the same request on OpenAI gpt-4o-mini. This means jobs
 *   continue running without interruption even after the Gemini daily quota is exhausted.
 *
 *   The fallback is sticky: once Gemini hits quota, all subsequent calls go to OpenAI
 *   for the next GEMINI_COOLDOWN_MS (default: 60 minutes) to avoid hammering the
 *   Gemini endpoint repeatedly. After the cooldown, Gemini is tried again.
 *
 * Cost comparison (per 1M tokens):
 *   gemini-3-flash-preview:  $0.50 input / $3.00 output
 *   gpt-4o-mini:             $0.15 input / $0.60 output  ← cheaper!
 *
 * Railway env vars:
 *   GEMINI_API_KEY    — Gemini API key (primary provider)
 *   GEMINI_MODEL      — Gemini model name (default: gemini-3-flash-preview)
 *   OPENAI_API_KEY    — OpenAI API key (fallback provider)
 *   OPENAI_MODEL      — OpenAI model name (default: gpt-4o-mini)
 *   GEMINI_COOLDOWN_MS — ms to stay on OpenAI after Gemini quota hit (default: 3600000 = 1h)
 */

import { type InvokeParams, type InvokeResult } from "./llm";
import { ENV } from "./env";

// ---------------------------------------------------------------------------
// Provider configuration
// ---------------------------------------------------------------------------
const GEMINI_API_KEY   = process.env.GEMINI_API_KEY ?? "";
const GEMINI_MODEL     = process.env.GEMINI_MODEL ?? "gemini-3-flash-preview";
const GEMINI_BASE_URL  = "https://generativelanguage.googleapis.com/v1beta/openai/";

const OPENAI_API_KEY   = process.env.OPENAI_API_KEY ?? ENV.openAiApiKey ?? "";
const OPENAI_MODEL     = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
const OPENAI_BASE_URL  = "https://api.openai.com/v1/";

const USE_GEMINI_PRIMARY = !!GEMINI_API_KEY;
const HAS_OPENAI_FALLBACK = !!OPENAI_API_KEY;

// How long to stay on OpenAI after Gemini quota is exhausted (default: 1 hour)
const GEMINI_COOLDOWN_MS = parseInt(process.env.GEMINI_COOLDOWN_MS ?? "3600000", 10);

// ---------------------------------------------------------------------------
// Pricing tables
// ---------------------------------------------------------------------------
const GEMINI_PRICING: Record<string, { input: number; output: number }> = {
  "gemini-3-flash-preview":        { input: 0.50,  output: 3.00  },
  "gemini-3.1-pro-preview":        { input: 2.00,  output: 12.00 },
  "gemini-3.1-flash-lite-preview": { input: 0.25,  output: 1.50  },
  "gemini-2.5-flash":              { input: 0.075, output: 0.30  },
  "gemini-2.5-pro":                { input: 1.25,  output: 10.00 },
};
const OPENAI_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini":  { input: 0.15, output: 0.60  },
  "gpt-4o":       { input: 2.50, output: 10.00 },
  "gpt-4.1-mini": { input: 0.40, output: 1.60  },
};

// ---------------------------------------------------------------------------
// Fallback state — shared across all calls in this process
// ---------------------------------------------------------------------------
let geminiQuotaExhaustedAt: number | null = null;  // timestamp when Gemini quota was hit
let geminiCallsOnFallback = 0;                      // how many calls went to OpenAI fallback

function isGeminiOnCooldown(): boolean {
  if (geminiQuotaExhaustedAt === null) return false;
  return Date.now() - geminiQuotaExhaustedAt < GEMINI_COOLDOWN_MS;
}

function markGeminiQuotaExhausted() {
  if (geminiQuotaExhaustedAt === null) {
    console.warn(
      `[LLM] Gemini daily quota exhausted — switching to OpenAI ${OPENAI_MODEL} fallback ` +
      `for ${Math.ceil(GEMINI_COOLDOWN_MS / 60_000)} minutes`,
    );
  }
  geminiQuotaExhaustedAt = Date.now();
}

// ---------------------------------------------------------------------------
// Statistics (combined across both providers)
// ---------------------------------------------------------------------------
let totalCalls        = 0;
let totalCost         = 0;
let totalErrors       = 0;
let totalInputTokens  = 0;
let totalOutputTokens = 0;
let geminiCalls       = 0;
let openaiCalls       = 0;

// ---------------------------------------------------------------------------
// Startup log
// ---------------------------------------------------------------------------
if (USE_GEMINI_PRIMARY) {
  const geminiPricing = GEMINI_PRICING[GEMINI_MODEL] ?? { input: 0.50, output: 3.00 };
  console.log(
    `[LLM] Primary: Gemini | Model: ${GEMINI_MODEL} | ` +
    `$${geminiPricing.input}/$${geminiPricing.output} per 1M tokens`,
  );
  if (HAS_OPENAI_FALLBACK) {
    const openaiPricing = OPENAI_PRICING[OPENAI_MODEL] ?? { input: 0.15, output: 0.60 };
    console.log(
      `[LLM] Fallback: OpenAI | Model: ${OPENAI_MODEL} | ` +
      `$${openaiPricing.input}/$${openaiPricing.output} per 1M tokens ` +
      `(activates on Gemini 429/quota exhaustion)`,
    );
  } else {
    console.warn(`[LLM] No OPENAI_API_KEY set — Gemini fallback disabled`);
  }
} else {
  const openaiPricing = OPENAI_PRICING[OPENAI_MODEL] ?? { input: 0.15, output: 0.60 };
  console.log(
    `[LLM] Provider: OpenAI | Model: ${OPENAI_MODEL} | ` +
    `$${openaiPricing.input}/$${openaiPricing.output} per 1M tokens`,
  );
}

// ---------------------------------------------------------------------------
// Core invocation — single provider call
// ---------------------------------------------------------------------------
async function callProvider(
  params: InvokeParams,
  baseUrl: string,
  apiKey: string,
  model: string,
  pricingTable: Record<string, { input: number; output: number }>,
  defaultPricing: { input: number; output: number },
): Promise<InvokeResult> {
  const { messages, tools, response_format, temperature } = params;

  const payload: Record<string, unknown> = {
    model,
    messages: messages.map(msg => ({
      role: msg.role,
      content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
    })),
  };

  if (temperature !== undefined) payload.temperature = temperature;
  if (tools && tools.length > 0) payload.tools = tools;
  if (response_format) payload.response_format = response_format;

  const response = await fetch(baseUrl + "chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();

  // Track cost
  const inputTokens  = data.usage?.prompt_tokens    || 0;
  const outputTokens = data.usage?.completion_tokens || 0;
  const pricing      = pricingTable[model] ?? defaultPricing;
  const cost         = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;

  totalCalls++;
  totalCost         += cost;
  totalInputTokens  += inputTokens;
  totalOutputTokens += outputTokens;

  return {
    id:      data.id,
    created: data.created,
    model:   data.model,
    choices: data.choices.map((c: any) => ({
      index:         c.index,
      message:       { role: c.message.role, content: c.message.content, tool_calls: c.message.tool_calls },
      finish_reason: c.finish_reason,
    })),
    usage: data.usage,
  };
}

// ---------------------------------------------------------------------------
// Public invokeLLM — Gemini primary with automatic OpenAI fallback
// ---------------------------------------------------------------------------
export async function invokeLLM(params: InvokeParams): Promise<InvokeResult> {
  // Determine which provider to use
  const useGemini = USE_GEMINI_PRIMARY && !isGeminiOnCooldown();

  if (useGemini) {
    try {
      const result = await callProvider(
        params,
        GEMINI_BASE_URL,
        GEMINI_API_KEY,
        GEMINI_MODEL,
        GEMINI_PRICING,
        { input: 0.50, output: 3.00 },
      );
      geminiCalls++;
      return result;
    } catch (err: any) {
      const is429 =
        err?.message?.includes("429") ||
        err?.message?.includes("RESOURCE_EXHAUSTED");

      if (is429 && HAS_OPENAI_FALLBACK) {
        // Mark Gemini as quota-exhausted and fall through to OpenAI
        markGeminiQuotaExhausted();
        // Fall through to OpenAI below
      } else {
        totalErrors++;
        throw err;
      }
    }
  }

  // OpenAI path (either primary when no Gemini key, or fallback)
  if (!OPENAI_API_KEY) {
    totalErrors++;
    throw new Error(
      USE_GEMINI_PRIMARY
        ? "Gemini quota exhausted and no OPENAI_API_KEY set for fallback"
        : "OpenAI API key not configured",
    );
  }

  try {
    geminiCallsOnFallback++;
    if (geminiCallsOnFallback % 50 === 1) {
      // Log periodically so it's visible in Railway logs
      console.log(
        `[LLM] Using OpenAI fallback (call #${geminiCallsOnFallback} since Gemini quota hit, ` +
        `cooldown resets in ${Math.ceil((GEMINI_COOLDOWN_MS - (Date.now() - (geminiQuotaExhaustedAt ?? 0))) / 60_000)} min)`,
      );
    }
    const result = await callProvider(
      params,
      OPENAI_BASE_URL,
      OPENAI_API_KEY,
      OPENAI_MODEL,
      OPENAI_PRICING,
      { input: 0.15, output: 0.60 },
    );
    openaiCalls++;
    return result;
  } catch (err: any) {
    totalErrors++;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------
export function getOpenAIStats() {
  return {
    totalCalls,
    totalCost,
    totalErrors,
    geminiCalls,
    openaiCalls,
    geminiOnCooldown: isGeminiOnCooldown(),
    geminiCooldownRemainingMin: geminiQuotaExhaustedAt
      ? Math.max(0, Math.ceil((GEMINI_COOLDOWN_MS - (Date.now() - geminiQuotaExhaustedAt)) / 60_000))
      : 0,
    errorRate:
      totalCalls > 0 ? ((totalErrors / totalCalls) * 100).toFixed(2) + "%" : "0%",
    totalInputTokens,
    totalOutputTokens,
  };
}

export function resetOpenAIStats() {
  totalCalls = totalCost = totalErrors = totalInputTokens = totalOutputTokens = 0;
  geminiCalls = openaiCalls = geminiCallsOnFallback = 0;
  geminiQuotaExhaustedAt = null;
}

// Re-export types
export type { InvokeParams, InvokeResult };
