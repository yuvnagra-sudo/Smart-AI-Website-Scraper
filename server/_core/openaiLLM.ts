/**
 * LLM Implementation — OpenAI only (gpt-5.4-mini / gpt-5.4-nano)
 *
 * Model selection (override via Railway env var OPENAI_MODEL):
 *   - gpt-5.4-mini  → capable, low cost (default)
 *   - gpt-5.4-nano  → fastest, cheapest (set OPENAI_MODEL=gpt-5.4-nano)
 *
 * Gemini has been removed. Only OpenAI is used.
 */

import { type InvokeParams, type InvokeResult } from "./llm";
import { ENV } from "./env";

// Default model — override globally via OPENAI_MODEL env var, or per-call via params.model
const LLM_MODEL_DEFAULT = process.env.OPENAI_MODEL ?? "gpt-5.4-mini";
const LLM_BASE_URL = "https://api.openai.com/v1/chat/completions";

// Pricing per 1M tokens by model family
function costFor(model: string): { input: number; output: number } {
  if (model.includes("nano")) return { input: 0.20, output: 0.80 };
  return { input: 0.75, output: 3.00 }; // mini (default)
}

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

  const { messages, tools, response_format, temperature, model: modelOverride } = params;
  const activeModel = modelOverride ?? LLM_MODEL_DEFAULT;

  // Build request payload
  const payload: Record<string, unknown> = {
    model: activeModel,
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

    // Track cost using per-call model pricing
    const inputTokens = data.usage?.prompt_tokens || 0;
    const outputTokens = data.usage?.completion_tokens || 0;
    const pricing = costFor(activeModel);
    const cost = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;

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
    activeModel: LLM_MODEL_DEFAULT,
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
