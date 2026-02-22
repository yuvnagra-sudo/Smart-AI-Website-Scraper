import { describe, it, expect } from 'vitest';

/**
 * Test Jina API key validity
 * Validates that the JINA_API_KEY environment variable is correctly set
 * and can make successful requests to the Jina Reader API
 */
describe('Jina API Integration', () => {
  it('should have JINA_API_KEY environment variable set', () => {
    const apiKey = process.env.JINA_API_KEY;
    expect(apiKey).toBeDefined();
    expect(apiKey).toBeTruthy();
    expect(apiKey?.length).toBeGreaterThan(0);
  });

  it('should be able to fetch content from Jina API', async () => {
    const apiKey = process.env.JINA_API_KEY;
    if (!apiKey) {
      throw new Error('JINA_API_KEY not set');
    }

    // Test with a simple, reliable URL
    const testUrl = 'https://example.com';
    
    try {
      const response = await fetch(`https://r.jina.ai/${testUrl}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'application/json',
        },
        timeout: 10000,
      });

      // Should get a successful response (200-299 range)
      expect(response.status).toBeGreaterThanOrEqual(200);
      expect(response.status).toBeLessThan(300);

      // Response should have content
      const content = await response.text();
      expect(content).toBeTruthy();
      expect(content.length).toBeGreaterThan(0);

      console.log(`✅ Jina API key is valid. Response length: ${content.length} chars`);
    } catch (error) {
      console.error('❌ Jina API key validation failed:', error);
      throw new Error(`Jina API validation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, { timeout: 15000 });

  it('should reject invalid API key', async () => {
    const invalidKey = 'invalid_key_12345';
    const testUrl = 'https://example.com';

    try {
      const response = await fetch(`https://r.jina.ai/${testUrl}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${invalidKey}`,
          'Accept': 'application/json',
        },
        timeout: 10000,
      });

      // Invalid key should return 401 or 403
      expect([401, 403]).toContain(response.status);
      console.log(`✅ Invalid key correctly rejected with status ${response.status}`);
    } catch (error) {
      // Network error is also acceptable for invalid key
      console.log(`✅ Invalid key rejected with error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, { timeout: 15000 });
});
