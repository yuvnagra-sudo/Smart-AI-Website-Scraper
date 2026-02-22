/**
 * Hybrid LLM System
 * 
 * Routes LLM requests intelligently between Manus (gemini-2.5-flash) and OpenAI (gpt-5-nano):
 * - Primary: Manus LLM (free, 100 RPM)
 * - Fallback: OpenAI (paid, 10,000 RPM) when Manus queue > threshold
 * 
 * This provides:
 * - Cost optimization (use free Manus when possible)
 * - Speed optimization (use fast OpenAI when queue is backed up)
 * - 600-1,200× speedup for large batch jobs
 */

import { invokeLLM as invokeManusLLM, type InvokeParams, type InvokeResult } from "./llm";

// Re-export types for consumers
export type { InvokeParams, InvokeResult };
import { llmQueue } from "./llmQueue";
import { ENV } from "./env";

// Configuration
const QUEUE_THRESHOLD = 50; // Switch to OpenAI when Manus queue > 50 requests
const OPENAI_MODEL = "gpt-5-nano"; // Cheapest model with same 10K RPM limit

// Statistics
let manusCallCount = 0;
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

  // Track cost (gpt-5-nano: $0.05 input, $0.40 output per 1M tokens)
  const inputTokens = data.usage?.prompt_tokens || 0;
  const outputTokens = data.usage?.completion_tokens || 0;
  const cost = (inputTokens * 0.05 + outputTokens * 0.40) / 1_000_000;
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
 * Hybrid LLM invocation
 * Routes to Manus or OpenAI based on queue depth
 */
export async function invokeHybridLLM(params: InvokeParams): Promise<InvokeResult> {
  // If Manus Forge API is not available (Railway/external deployment), use OpenAI directly
  const manusForgeAvailable = ENV.forgeApiUrl && ENV.forgeApiKey;
  
  if (!manusForgeAvailable && ENV.openAiApiKey) {
    openaiCallCount++;
    if (openaiCallCount === 1) {
      console.log(`[Hybrid LLM] Manus Forge API not available, using OpenAI exclusively`);
    }
    return await invokeOpenAI(params);
  }

  const stats = llmQueue.getStatistics();
  const queueDepth = stats.queueDepth;

  // Decision: Use OpenAI if queue is backed up
  const useOpenAI = queueDepth > QUEUE_THRESHOLD && ENV.openAiApiKey;

  if (useOpenAI) {
    openaiCallCount++;
    console.log(`[Hybrid LLM] Using OpenAI (queue: ${queueDepth}, calls: ${openaiCallCount}, cost: $${totalCost.toFixed(4)})`);
    return await invokeOpenAI(params);
  } else {
    manusCallCount++;
    if (queueDepth > 20) {
      console.log(`[Hybrid LLM] Using Manus (queue: ${queueDepth}, calls: ${manusCallCount})`);
    }
    return await invokeManusLLM(params);
  }
}

/**
 * Get hybrid LLM statistics
 */
export function getHybridLLMStats() {
  const stats = llmQueue.getStatistics();
  return {
    manusCallCount,
    openaiCallCount,
    totalCost,
    queueDepth: stats.queueDepth,
  };
}

/**
 * Reset statistics (for testing)
 */
export function resetHybridLLMStats() {
  manusCallCount = 0;
  openaiCallCount = 0;
  totalCost = 0;
}
