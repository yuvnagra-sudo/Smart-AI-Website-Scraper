import { describe, it, expect } from "vitest";
import { invokeLLM, getOpenAIStats, resetOpenAIStats } from "./_core/openaiLLM";

describe("OpenAI-Only LLM", () => {
  it("should successfully call OpenAI API directly", async () => {
    resetOpenAIStats();

    // Make a simple LLM call
    const result = await invokeLLM({
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Say 'Hello from OpenAI!' and nothing else." },
      ],
    });

    // Verify response structure
    expect(result).toBeDefined();
    expect(result.choices).toBeDefined();
    expect(result.choices.length).toBeGreaterThan(0);
    expect(result.choices[0].message).toBeDefined();
    expect(result.choices[0].message.content).toBeDefined();

    // Verify response contains expected text
    const content = result.choices[0].message.content;
    expect(typeof content).toBe("string");
    expect(content.toLowerCase()).toContain("hello");

    // Check stats
    const stats = getOpenAIStats();
    console.log("OpenAI Stats:", stats);
    expect(stats.totalCalls).toBe(1);
    expect(stats.totalCost).toBeGreaterThan(0);

    console.log("✅ OpenAI-only LLM test passed");
    console.log(`   Response: ${content}`);
    console.log(`   Total calls: ${stats.totalCalls}`);
    console.log(`   Total cost: $${stats.totalCost.toFixed(6)}`);
  }, 30000); // 30 second timeout
});
