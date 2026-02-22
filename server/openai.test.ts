import { describe, it, expect } from "vitest";
import { ENV } from "./_core/env";

describe("OpenAI API Key Validation", () => {
  it("should successfully call OpenAI API with provided key", async () => {
    // Validate that the API key is set
    expect(ENV.openAiApiKey).toBeDefined();
    expect(ENV.openAiApiKey).not.toBe("");

    // Make a minimal API call to validate the key
    const response = await fetch("https://api.openai.com/v1/models", {
      headers: {
        "Authorization": `Bearer ${ENV.openAiApiKey}`,
      },
    });

    expect(response.status).toBe(200);
    
    const data = await response.json();
    expect(data.data).toBeDefined();
    expect(Array.isArray(data.data)).toBe(true);
    expect(data.data.length).toBeGreaterThan(0);
    
    // Verify gpt-5-nano is available
    const hasGpt5Nano = data.data.some((model: any) => 
      model.id.includes("gpt-5-nano") || model.id.includes("gpt-4o-mini")
    );
    expect(hasGpt5Nano).toBe(true);
    
    console.log("✅ OpenAI API key validated successfully");
    console.log(`   Available models: ${data.data.length}`);
  }, 10000); // 10 second timeout
});
