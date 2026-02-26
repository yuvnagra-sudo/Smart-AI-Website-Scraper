/**
 * LLM Implementation — OpenAI or Gemini (OpenAI-compatible)
 *
 * Provider is selected at runtime:
 *   - If GEMINI_API_KEY is set → uses Gemini 2.5 Flash (50% cheaper, faster)
 *   - Otherwise → uses OpenAI (model via OPENAI_MODEL env var, default: gpt-4o-mini)
 *
 * Gemini 2.5 Flash uses Google's OpenAI-compatible endpoint so the code change is minimal.
 * To switch providers in Railway: add/remove the GEMINI_API_KEY env var.
 */

import { type InvokeParams, type InvokeResult } from "./llm";
import { ENV } from "./env";

const USE_GEMINI = !!process.env.GEMINI_API_KEY;
const LLM_BASE_URL = USE_GEMINI
  ? "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
  : "https://api.openai.com/v1/chat/completions";
const LLM_MODEL = USE_GEMINI
  ? (process.env.GEMINI_MODEL ?? "gemini-2.5-flash")
  : (process.env.OPENAI_MODEL ?? "gpt-4o-mini");
const LLM_API_KEY = USE_GEMINI
  ? (process.env.GEMINI_API_KEY ?? "")
  : ENV.openAiApiKey;
// Pricing per 1M tokens for cost tracking
const INPUT_COST_PER_1M  = USE_GEMINI ? 0.075 : 0.15;
const OUTPUT_COST_PER_1M = USE_GEMINI ? 0.30  : 0.60;

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

  const { messages, tools, response_format } = params;

  // Build request payload
  const payload: Record<string, unknown> = {
    model: LLM_MODEL,
    messages: messages.map(msg => ({
      role: msg.role,
      content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
    })),
  };

  if (tools && tools.length > 0) {
    payload.tools = tools;
  }

  if (response_format) {
    payload.response_format = response_format;
  }

  try {
    // Call LLM API (OpenAI or Gemini OpenAI-compatible endpoint)
    const response = await fetch(LLM_BASE_URL, {
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
