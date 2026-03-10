/**
 * LLM Implementation — OpenAI primary (Gemini removed)
 *
 * Provider: OpenAI (gpt-5-mini by default)
 *
 * Railway env vars:
 *   OPENAI_API_KEY  — OpenAI API key (required)
 *   OPENAI_MODEL    — model name (default: gpt-5-mini)
 *
 * Cost comparison (per 1M tokens):
 *   gpt-5-mini:   $0.25 input / $2.00 output  ← default, best value for structured extraction
 *   gpt-5-nano:   $0.05 input / $0.40 output  ← cheapest, simpler tasks only
 *   gpt-5:        $1.25 input / $10.00 output
 *   gpt-4o-mini:  $0.15 input / $0.60 output  ← legacy fallback
 */

import { type InvokeParams, type InvokeResult } from "./llm";
import { ENV } from "./env";

// ---------------------------------------------------------------------------
// Provider configuration
// ---------------------------------------------------------------------------
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY ?? ENV.openAiApiKey ?? "";
const OPENAI_MODEL    = process.env.OPENAI_MODEL ?? "gpt-5-mini";
const OPENAI_BASE_URL = "https://api.openai.com/v1/";

// ---------------------------------------------------------------------------
// Pricing tables (per 1M tokens, Mar 2026)
// ---------------------------------------------------------------------------
const OPENAI_PRICING: Record<string, { input: number; output: number }> = {
  // GPT-5 family
  "gpt-5.4":      { input: 2.50,  output: 15.00 },
  "gpt-5.2":      { input: 1.75,  output: 14.00 },
  "gpt-5.1":      { input: 1.25,  output: 10.00 },
  "gpt-5":        { input: 1.25,  output: 10.00 },
  "gpt-5-mini":   { input: 0.25,  output: 2.00  },  // ← default, best value
  "gpt-5-nano":   { input: 0.05,  output: 0.40  },
  // GPT-4.1 family
  "gpt-4.1":      { input: 3.00,  output: 12.00 },
  "gpt-4.1-mini": { input: 0.40,  output: 1.60  },
  "gpt-4.1-nano": { input: 0.10,  output: 0.40  },
  // Legacy
  "gpt-4o":       { input: 2.50,  output: 10.00 },
  "gpt-4o-mini":  { input: 0.15,  output: 0.60  },
};

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------
let totalCalls        = 0;
let totalCost         = 0;
let totalErrors       = 0;
let totalInputTokens  = 0;
let totalOutputTokens = 0;

// ---------------------------------------------------------------------------
// Startup log
// ---------------------------------------------------------------------------
const pricing = OPENAI_PRICING[OPENAI_MODEL] ?? { input: 0.25, output: 2.00 };
if (!OPENAI_API_KEY) {
  console.error(`[LLM] ❌ OPENAI_API_KEY is not set — all LLM calls will fail`);
} else {
  console.log(
    `[LLM] Provider: OpenAI | Model: ${OPENAI_MODEL} | ` +
    `$${pricing.input}/$${pricing.output} per 1M tokens`,
  );
}

// ---------------------------------------------------------------------------
// Public invokeLLM
// ---------------------------------------------------------------------------
export async function invokeLLM(params: InvokeParams): Promise<InvokeResult> {
  if (!OPENAI_API_KEY) {
    totalErrors++;
    throw new Error("OPENAI_API_KEY is not configured");
  }

  const { messages, tools, response_format, temperature } = params;

  const payload: Record<string, unknown> = {
    model: OPENAI_MODEL,
    messages: messages.map(msg => ({
      role: msg.role,
      content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
    })),
  };

  if (temperature !== undefined) payload.temperature = temperature;
  if (tools && tools.length > 0) payload.tools = tools;
  if (response_format) payload.response_format = response_format;

  const response = await fetch(OPENAI_BASE_URL + "chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    totalErrors++;
    throw new Error(`LLM API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();

  // Track cost
  const inputTokens  = data.usage?.prompt_tokens    || 0;
  const outputTokens = data.usage?.completion_tokens || 0;
  const p            = OPENAI_PRICING[OPENAI_MODEL] ?? { input: 0.25, output: 2.00 };
  const cost         = (inputTokens * p.input + outputTokens * p.output) / 1_000_000;

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
// Statistics
// ---------------------------------------------------------------------------
export function getOpenAIStats() {
  return {
    totalCalls,
    totalCost,
    totalErrors,
    geminiCalls: 0,
    openaiCalls: totalCalls,
    geminiOnCooldown: false,
    geminiCooldownRemainingMin: 0,
    errorRate:
      totalCalls > 0 ? ((totalErrors / totalCalls) * 100).toFixed(2) + "%" : "0%",
    totalInputTokens,
    totalOutputTokens,
  };
}

export function resetOpenAIStats() {
  totalCalls = totalCost = totalErrors = totalInputTokens = totalOutputTokens = 0;
}

// Re-export types
export type { InvokeParams, InvokeResult };
