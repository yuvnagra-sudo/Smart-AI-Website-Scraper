/**
 * LLM Implementation — Gemini 3 (default) or OpenAI (fallback)
 *
 * Provider is selected at runtime:
 *   - If GEMINI_API_KEY is set → uses Gemini (model via GEMINI_MODEL env var)
 *       Default model: gemini-3-flash-preview  ($0.50/$3.00 per 1M tokens)
 *       Better output:  gemini-3.1-pro-preview  ($2.00/$12.00 per 1M tokens)
 *       Budget option:  gemini-3.1-flash-lite-preview ($0.25/$1.50 per 1M tokens)
 *   - Otherwise → uses OpenAI (model via OPENAI_MODEL env var, default: gpt-4o-mini)
 *
 * All Gemini 3 models use Google's OpenAI-compatible endpoint.
 * To switch models in Railway: set GEMINI_MODEL to the desired model ID.
 *
 * Gemini 3 Flash vs 3.1 Pro:
 *   - gemini-3-flash-preview:     fast, frontier-class intelligence, best value for scraping
 *   - gemini-3.1-pro-preview:     highest accuracy, best for complex/ambiguous pages, 4x cost
 *   - gemini-3.1-flash-lite-preview: cheapest, good for simple structured extraction
 */

import { type InvokeParams, type InvokeResult } from "./llm";
import { ENV } from "./env";

const USE_GEMINI = !!process.env.GEMINI_API_KEY;
const LLM_BASE_URL = USE_GEMINI
  ? "https://generativelanguage.googleapis.com/v1beta/openai/"
  : "https://api.openai.com/v1/";
// Default to gemini-3-flash-preview — best balance of quality and cost for agentic scraping
const LLM_MODEL = USE_GEMINI
  ? (process.env.GEMINI_MODEL ?? "gemini-3-flash-preview")
  : (process.env.OPENAI_MODEL ?? "gpt-4o-mini");
const LLM_API_KEY = USE_GEMINI
  ? (process.env.GEMINI_API_KEY ?? "")
  : ENV.openAiApiKey;

// Pricing per 1M tokens for cost tracking (Gemini 3 Flash default)
const GEMINI_PRICING: Record<string, { input: number; output: number }> = {
  "gemini-3-flash-preview":          { input: 0.50,  output: 3.00 },
  "gemini-3.1-pro-preview":          { input: 2.00,  output: 12.00 },
  "gemini-3.1-flash-lite-preview":   { input: 0.25,  output: 1.50 },
  "gemini-2.5-flash":                { input: 0.075, output: 0.30 },
  "gemini-2.5-pro":                  { input: 1.25,  output: 10.00 },
};
const OPENAI_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini":  { input: 0.15, output: 0.60 },
  "gpt-4o":       { input: 2.50, output: 10.00 },
  "gpt-4.1-mini": { input: 0.40, output: 1.60 },
};
const _pricing = USE_GEMINI
  ? (GEMINI_PRICING[LLM_MODEL] ?? { input: 0.50, output: 3.00 })
  : (OPENAI_PRICING[LLM_MODEL] ?? { input: 0.15, output: 0.60 });
const INPUT_COST_PER_1M  = _pricing.input;
const OUTPUT_COST_PER_1M = _pricing.output;

console.log(`[LLM] Provider: ${USE_GEMINI ? 'Gemini' : 'OpenAI'} | Model: ${LLM_MODEL} | Pricing: $${INPUT_COST_PER_1M}/$${OUTPUT_COST_PER_1M} per 1M tokens`);

// Statistics
let totalCalls = 0;
let totalCost = 0;
let totalErrors = 0;
let totalInputTokens = 0;
let totalOutputTokens = 0;

/**
 * Invoke OpenAI API directly
 */
export async function invokeLLM(params: InvokeParams): Promise<InvokeResult> {
  if (!LLM_API_KEY) {
    throw new Error(USE_GEMINI ? "Gemini API key not configured" : "OpenAI API key not configured");
  }

  const { messages, tools, response_format, temperature } = params;

  // Build request payload
  const payload: Record<string, unknown> = {
    model: LLM_MODEL,
    messages: messages.map(msg => ({
      role: msg.role,
      content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
    })),
  };

  if (temperature !== undefined) {
    payload.temperature = temperature;
  }

  if (tools && tools.length > 0) {
    payload.tools = tools;
  }

  if (response_format) {
    payload.response_format = response_format;
  }

  try {
    // Call LLM API (OpenAI or Gemini OpenAI-compatible endpoint)
    const endpoint = LLM_BASE_URL + "chat/completions";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${LLM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`LLM API error (${response.status}): ${error}`);
    }

    const data = await response.json();

    // Track cost using active provider pricing
    const inputTokens = data.usage?.prompt_tokens || 0;
    const outputTokens = data.usage?.completion_tokens || 0;
    const cost = (inputTokens * INPUT_COST_PER_1M + outputTokens * OUTPUT_COST_PER_1M) / 1_000_000;

    totalCalls++;
    totalCost += cost;
    totalInputTokens += inputTokens;
    totalOutputTokens += outputTokens;

    // Return in standard format
    return {
      id: data.id,
      created: data.created,
      model: data.model,
      choices: data.choices.map((choice: any) => ({
        index: choice.index,
        message: {
          role: choice.message.role,
          content: choice.message.content,
          tool_calls: choice.message.tool_calls,
        },
        finish_reason: choice.finish_reason,
      })),
      usage: data.usage,
    };
  } catch (error) {
    totalErrors++;
    throw error;
  }
}

/**
 * Get OpenAI LLM statistics
 */
export function getOpenAIStats() {
  return {
    totalCalls,
    totalCost,
    totalErrors,
    errorRate: totalCalls > 0 ? (totalErrors / totalCalls * 100).toFixed(2) + '%' : '0%',
    totalInputTokens,
    totalOutputTokens,
  };
}

/**
 * Reset statistics (for testing)
 */
export function resetOpenAIStats() {
  totalCalls = 0;
  totalCost = 0;
  totalErrors = 0;
  totalInputTokens = 0;
  totalOutputTokens = 0;
}

// Re-export types for consumers
export type { InvokeParams, InvokeResult };
