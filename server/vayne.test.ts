/**
 * Vayne.io API Connection Test
 * Validates that the VAYNE_API_KEY is correctly configured
 */

import { describe, it, expect } from "vitest";
import { testVayneConnection, extractWithVayne } from "./vayneClient";

describe("Vayne.io API", () => {
  it("should have valid API key and connect successfully", async () => {
    const isConnected = await testVayneConnection();
    expect(isConnected).toBe(true);
  }, 30000); // 30 second timeout

  it("should extract data from a simple webpage", async () => {
    const result = await extractWithVayne({
      url: "https://example.com",
      instructions: "Extract the page title",
      timeout: 15,
    });

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.metadata).toBeDefined();
    expect(result.metadata?.url).toBe("https://example.com");
  }, 30000);
});
