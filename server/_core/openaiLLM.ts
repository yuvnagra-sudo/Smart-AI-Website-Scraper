/**
 * OpenAI-Only LLM Implementation
 *
 * Direct OpenAI API calls without queue or hybrid complexity.
 * Model is configured via the OPENAI_MODEL env var (default: gpt-4o-mini).
 * gpt-4o-mini remains available in the OpenAI API and is cost-efficient at scale.
 * To upgrade to a newer model, set OPENAI_MODEL=gpt-4.1-mini or similar in your .env.
 */

import { type InvokeParams, type InvokeResult } from "./llm";
import { ENV } from "./env";

const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

// Statistics
let totalCalls = 0;
let totalCost = 0;
let totalErrors = 0;

/**
 * Invoke OpenAI API directly
 */
export async function invokeLLM(params: InvokeParams): Promise<InvokeResult> {
  if (!ENV.openAiApiKey) {
    throw new Error("OpenAI API key not configured");
  }

  const { messages, tools, response_format } = params;

  // Build OpenAI request payload
  const payload: Record<string, unknown> = {
    model: OPENAI_MODEL,
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
    // Call OpenAI API
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ENV.openAiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${error}`);
    }

    const data = await response.json();

    // Track cost (gpt-4o-mini: $0.15 input, $0.60 output per 1M tokens)
    const inputTokens = data.usage?.prompt_tokens || 0;
    const outputTokens = data.usage?.completion_tokens || 0;
    const cost = (inputTokens * 0.15 + outputTokens * 0.60) / 1_000_000;
    
    totalCalls++;
    totalCost += cost;

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
  };
}

/**
 * Reset statistics (for testing)
 */
export function resetOpenAIStats() {
  totalCalls = 0;
  totalCost = 0;
  totalErrors = 0;
}

// Re-export types for consumers
export type { InvokeParams, InvokeResult };
