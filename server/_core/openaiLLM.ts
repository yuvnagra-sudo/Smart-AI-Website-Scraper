/**
 * LLM Implementation — OpenAI only (gpt-4.1-mini / gpt-4.1-nano)
 *
 * Model selection (override via Railway env var OPENAI_MODEL):
 *   - gpt-4.1-mini  → capable, low cost (default)
 *   - gpt-4.1-nano  → fastest, cheapest (set OPENAI_MODEL=gpt-4.1-nano)
 *
 * Gemini has been removed. Only OpenAI is used.
 */

import { type InvokeParams, type InvokeResult } from "./llm";
import { ENV } from "./env";

// Active model — default gpt-4.1-mini, override via OPENAI_MODEL env var
const LLM_MODEL = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
const LLM_BASE_URL = "https://api.openai.com/v1/chat/completions";

// gpt-4.1-mini: $0.40 input / $1.60 output per 1M tokens
// gpt-4.1-nano: $0.10 input / $0.40 output per 1M tokens
const INPUT_COST_PER_1M  = LLM_MODEL.includes("nano") ? 0.10 : 0.40;
const OUTPUT_COST_PER_1M = LLM_MODEL.includes("nano") ? 0.40 : 1.60;

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
  if (!ENV.openAiApiKey) {
    throw new Error("OpenAI API key not configured");
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
    const response = await fetch(LLM_BASE_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ENV.openAiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`LLM API error (${response.status}): ${error}`);
    }

    const data = await response.json();

    // Track cost
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
    errorRate: totalCalls > 0 ? (totalErrors / totalCalls * 100).toFixed(2) + "%" : "0%",
    totalInputTokens,
    totalOutputTokens,
    activeModel: LLM_MODEL,
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
