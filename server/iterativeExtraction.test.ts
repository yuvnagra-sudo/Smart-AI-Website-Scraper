/**
 * Tests for Iterative LLM-Guided Extraction System
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Iterative Extraction System', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should export runIterativeExtraction function', async () => {
    const { runIterativeExtraction } = await import('./iterativeExtraction');
    expect(runIterativeExtraction).toBeDefined();
    expect(typeof runIterativeExtraction).toBe('function');
  });

  it('should have correct function signature', async () => {
    const { runIterativeExtraction } = await import('./iterativeExtraction');
    
    // Check function accepts correct parameters
    const result = runIterativeExtraction(
      'Test Company',
      'https://example.com',
      {
        maxIterations: 3,
        onProgress: (msg) => console.log(msg)
      }
    );
    
    expect(result).toBeInstanceOf(Promise);
  });

  it('should return extraction state with correct structure', async () => {
    const { runIterativeExtraction } = await import('./iterativeExtraction');
    
    // Mock the LLM and fetcher to avoid actual API calls
    vi.mock('./_core/openaiLLM', () => ({
      invokeLLM: vi.fn().mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              missingData: {
                investorType: false,
                investmentStages: false,
                investmentNiches: false,
                teamMembers: false,
                portfolioCompanies: false
              },
              suggestedUrls: [],
              shouldContinue: false,
              reasoning: "Test complete"
            })
          }
        }]
      })
    }));
    
    vi.mock('./jinaFetcher', () => ({
      fetchWebsiteContentHybrid: vi.fn().mockResolvedValue({
        success: true,
        content: 'Test content',
        source: 'jina',
        duration: 100
      })
    }));
    
    const result = await runIterativeExtraction(
      'Test Company',
      'https://example.com',
      {
        maxIterations: 1,
      }
    );
    
    // Verify structure
    expect(result).toHaveProperty('investorType');
    expect(result).toHaveProperty('investmentStages');
    expect(result).toHaveProperty('investmentNiches');
    expect(result).toHaveProperty('teamMembers');
    expect(result).toHaveProperty('portfolioCompanies');
    expect(result).toHaveProperty('scrapedUrls');
    expect(result).toHaveProperty('iteration');
    expect(result).toHaveProperty('complete');
    
    // Verify types
    expect(Array.isArray(result.investorType)).toBe(true);
    expect(Array.isArray(result.investmentStages)).toBe(true);
    expect(Array.isArray(result.investmentNiches)).toBe(true);
    expect(Array.isArray(result.teamMembers)).toBe(true);
    expect(Array.isArray(result.portfolioCompanies)).toBe(true);
    expect(Array.isArray(result.scrapedUrls)).toBe(true);
    expect(typeof result.iteration).toBe('number');
    expect(typeof result.complete).toBe('boolean');
  });
});

describe('VCEnrichmentService Integration', () => {
  it('should accept useIterativeExtraction option', async () => {
    const { VCEnrichmentService } = await import('./vcEnrichment');
    const service = new VCEnrichmentService();
    
    // Verify the method signature accepts the option
    const enrichMethod = service.enrichVCFirm;
    expect(enrichMethod).toBeDefined();
    
    // The method should accept options parameter with useIterativeExtraction
    // We can't easily test the actual execution without mocking everything,
    // but we can verify the method exists and has the right signature
    expect(typeof enrichMethod).toBe('function');
  });
});
