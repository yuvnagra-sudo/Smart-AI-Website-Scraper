/**
 * Hybrid LLM System — OpenAI only (gpt-5.4-mini / gpt-5.4-nano)
 *
 * Manus Forge and Gemini have been removed.
 * All LLM calls route through OpenAI.
 * Set OPENAI_MODEL=gpt-5.4-nano in Railway for cheapest/fastest mode.
 */
import { type InvokeParams, type InvokeResult } from "./llm";
import { ENV } from "./env";

// Re-export types for consumers
export type { InvokeParams, InvokeResult };

// Use gpt-5.4-mini by default; set OPENAI_MODEL=gpt-5.4-nano for cheapest/fastest
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-5.4-mini";

// Statistics
let openaiCallCount = 0;
let totalCost = 0;

/**
 * Invoke OpenAI API directly
 */
async function invokeOpenAI(params: InvokeParams): Promise<InvokeResult> {
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

  // gpt-5.4-mini: $0.75/$3.00 per 1M; gpt-5.4-nano: $0.20/$0.80 per 1M
  const inputCostPer1M  = OPENAI_MODEL.includes("nano") ? 0.20 : 0.75;
  const outputCostPer1M = OPENAI_MODEL.includes("nano") ? 0.80 : 3.00;
  const inputTokens = data.usage?.prompt_tokens || 0;
  const outputTokens = data.usage?.completion_tokens || 0;
  const cost = (inputTokens * inputCostPer1M + outputTokens * outputCostPer1M) / 1_000_000;
  totalCost += cost;

  // Convert to Manus LLM format
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
}

/**
 * Hybrid LLM invocation — always uses OpenAI (Manus Forge removed)
 */
export async function invokeHybridLLM(params: InvokeParams): Promise<InvokeResult> {
  openaiCallCount++;
  return await invokeOpenAI(params);
}

/**
 * Get hybrid LLM statistics
 */
export function getHybridLLMStats() {
  return {
    openaiCallCount,
    totalCost,
    activeModel: OPENAI_MODEL,
  };
}
/**
 * Reset statistics (for testing)
 */
export function resetHybridLLMStats() {
  openaiCallCount = 0;
  totalCost = 0;
}
