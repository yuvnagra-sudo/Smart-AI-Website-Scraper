import { describe, it, expect } from "vitest";
import { invokeHybridLLM, getHybridLLMStats, resetHybridLLMStats } from "./_core/hybridLLM";

describe("Hybrid LLM System", () => {
  it("should successfully call hybrid LLM (Manus or OpenAI)", async () => {
    resetHybridLLMStats();

    // Make a simple LLM call
    const result = await invokeHybridLLM({
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Say 'Hello, World!' and nothing else." },
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
    const stats = getHybridLLMStats();
    console.log("Hybrid LLM Stats:", stats);
    expect(stats.manusCallCount + stats.openaiCallCount).toBe(1);

    console.log("✅ Hybrid LLM test passed");
    console.log(`   Response: ${content}`);
    console.log(`   Manus calls: ${stats.manusCallCount}, OpenAI calls: ${stats.openaiCallCount}`);
    console.log(`   Total cost: $${stats.totalCost.toFixed(4)}`);
  }, 30000); // 30 second timeout
});
