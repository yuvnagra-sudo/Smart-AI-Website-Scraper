/**
 * Tests for the LLM-driven Recursive Scraper
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the LLM queue before importing the modules
vi.mock('./_core/llmQueue', () => ({
  queuedLLMCall: vi.fn()
}));

import { scrapeRecursively } from './recursiveScraper';
import { queuedLLMCall } from './_core/llmQueue';

const mockQueuedLLMCall = vi.mocked(queuedLLMCall);

describe('RecursiveScraper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('scrapeRecursively', () => {
    // Helper to create HTML content that's long enough (> 100 chars)
    const createMockHtml = (content: string) => `
      <html>
        <head><title>Test Page</title></head>
        <body>
          <div class="content">${content}</div>
          <!-- Padding to ensure content length > 100 -->
          <footer>Copyright 2024 Test VC. All rights reserved. Contact us for more information.</footer>
        </body>
      </html>
    `;

    it('should extract team members from homepage when no other pages found', async () => {
      // Mock fetch function - must return content > 100 chars
      const mockFetch = vi.fn().mockResolvedValue(createMockHtml(`
        <h1>Test VC Firm</h1>
        <div class="team">
          <div class="member">
            <h3>John Smith</h3>
            <p>Managing Partner</p>
            <a href="mailto:john@testvc.com">Email</a>
            <a href="https://linkedin.com/in/johnsmith">LinkedIn</a>
          </div>
          <div class="member">
            <h3>Jane Doe</h3>
            <p>Principal</p>
          </div>
        </div>
      `));

      // Mock LLM response for page analysis
      mockQueuedLLMCall.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              page_type: 'homepage',
              content_quality: 'high',
              team_members: [
                {
                  name: 'John Smith',
                  title: 'Managing Partner',
                  job_function: 'Managing Partner',
                  specialization: 'FinTech',
                  email: 'john@testvc.com',
                  linkedin_url: 'https://linkedin.com/in/johnsmith',
                  profile_url: '',
                  portfolio_companies: ['Company A', 'Company B']
                },
                {
                  name: 'Jane Doe',
                  title: 'Principal',
                  job_function: 'Principal',
                  specialization: 'Healthcare',
                  email: '',
                  linkedin_url: '',
                  profile_url: '',
                  portfolio_companies: []
                }
              ],
              portfolio_companies: [],
              firm_description: 'Test VC is a leading venture capital firm.',
              suggested_urls: [],
              has_more_content: false,
              load_more_selector: '',
              notes: 'Homepage with team section'
            })
          }
        }]
      });

      const result = await scrapeRecursively(
        'Test VC',
        'https://testvc.com',
        mockFetch,
        { maxDepth: 2, maxPages: 5, enableDeepProfiles: false }
      );

      expect(result.success).toBe(true);
      expect(result.teamMembers).toHaveLength(2);
      expect(result.teamMembers[0].name).toBe('John Smith');
      expect(result.teamMembers[0].email).toBe('john@testvc.com');
      expect(result.teamMembers[0].linkedinUrl).toBe('https://linkedin.com/in/johnsmith');
      expect(result.teamMembers[1].name).toBe('Jane Doe');
      expect(result.firmDescription).toBe('Test VC is a leading venture capital firm.');
      expect(result.stats.totalPagesVisited).toBe(1);
    });

    it('should follow suggested URLs and deduplicate team members', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(createMockHtml('Homepage content with team information and more details about the firm'))
        .mockResolvedValueOnce(createMockHtml('Team page content with all team members listed here'));

      // First call: homepage analysis
      mockQueuedLLMCall
        .mockResolvedValueOnce({
          choices: [{
            message: {
              content: JSON.stringify({
                page_type: 'homepage',
                content_quality: 'medium',
                team_members: [
                  { name: 'John Smith', title: 'Partner', job_function: 'Partner', specialization: '', email: '', linkedin_url: '', profile_url: '', portfolio_companies: [] }
                ],
                portfolio_companies: [],
                firm_description: 'A VC firm',
                suggested_urls: [
                  { url: 'https://testvc.com/team', reason: 'Team page', priority: 'high', expected_content: 'team' }
                ],
                has_more_content: false,
                load_more_selector: '',
                notes: ''
              })
            }
          }]
        })
        // Second call: team page analysis
        .mockResolvedValueOnce({
          choices: [{
            message: {
              content: JSON.stringify({
                page_type: 'team_listing',
                content_quality: 'high',
                team_members: [
                  { name: 'John Smith', title: 'Managing Partner', job_function: 'Managing Partner', specialization: 'SaaS', email: 'john@testvc.com', linkedin_url: 'https://linkedin.com/in/johnsmith', profile_url: '', portfolio_companies: [] },
                  { name: 'Jane Doe', title: 'Principal', job_function: 'Principal', specialization: 'AI', email: '', linkedin_url: '', profile_url: '', portfolio_companies: [] }
                ],
                portfolio_companies: [],
                firm_description: '',
                suggested_urls: [],
                has_more_content: false,
                load_more_selector: '',
                notes: ''
              })
            }
          }]
        });

      const result = await scrapeRecursively(
        'Test VC',
        'https://testvc.com',
        mockFetch,
        { maxDepth: 2, maxPages: 5, enableDeepProfiles: false, delayBetweenPages: 0 }
      );

      expect(result.success).toBe(true);
      // Should deduplicate John Smith (appears on both pages)
      expect(result.teamMembers).toHaveLength(2);
      // Should have merged data - dedup prefers first non-empty value
      // First page had title 'Partner', second had 'Managing Partner'
      // So merged result keeps 'Partner' (first non-empty)
      const john = result.teamMembers.find(m => m.name === 'John Smith');
      expect(john?.title).toBe('Partner'); // First non-empty value wins
      expect(john?.email).toBe('john@testvc.com'); // From second page
      expect(result.stats.totalPagesVisited).toBe(2);
    });

    it('should respect maxDepth limit', async () => {
      const mockFetch = vi.fn().mockResolvedValue(createMockHtml('Content page with information about the venture capital firm'));

      // Always suggest more URLs
      mockQueuedLLMCall.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              page_type: 'other',
              content_quality: 'low',
              team_members: [],
              portfolio_companies: [],
              firm_description: '',
              suggested_urls: [
                { url: 'https://testvc.com/deep/page', reason: 'More content', priority: 'high', expected_content: 'team' }
              ],
              has_more_content: false,
              load_more_selector: '',
              notes: ''
            })
          }
        }]
      });

      const result = await scrapeRecursively(
        'Test VC',
        'https://testvc.com',
        mockFetch,
        { maxDepth: 1, maxPages: 10, enableDeepProfiles: false, delayBetweenPages: 0 }
      );

      // Should stop at depth 1 (homepage + 1 level deep)
      expect(result.stats.maxDepthReached).toBeLessThanOrEqual(1);
    });

    it('should respect maxPages limit', async () => {
      const mockFetch = vi.fn().mockResolvedValue(createMockHtml('Content page with information about the venture capital firm'));

      // Always suggest more URLs
      let callCount = 0;
      mockQueuedLLMCall.mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          choices: [{
            message: {
              content: JSON.stringify({
                page_type: 'team_listing',
                content_quality: 'medium',
                team_members: [
                  { name: `Person ${callCount}`, title: 'Partner', job_function: 'Partner', specialization: '', email: '', linkedin_url: '', profile_url: '', portfolio_companies: [] }
                ],
                portfolio_companies: [],
                firm_description: '',
                suggested_urls: [
                  { url: `https://testvc.com/page${callCount + 1}`, reason: 'More', priority: 'high', expected_content: 'team' },
                  { url: `https://testvc.com/page${callCount + 2}`, reason: 'More', priority: 'high', expected_content: 'team' }
                ],
                has_more_content: false,
                load_more_selector: '',
                notes: ''
              })
            }
          }]
        });
      });

      const result = await scrapeRecursively(
        'Test VC',
        'https://testvc.com',
        mockFetch,
        { maxDepth: 10, maxPages: 3, enableDeepProfiles: false, delayBetweenPages: 0 }
      );

      expect(result.stats.totalPagesVisited).toBe(3);
    });

    it('should handle fetch errors gracefully', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(createMockHtml('Homepage content with team information and more details'))
        .mockResolvedValueOnce(null); // Simulate fetch failure

      mockQueuedLLMCall
        .mockResolvedValueOnce({
          choices: [{
            message: {
              content: JSON.stringify({
                page_type: 'homepage',
                content_quality: 'medium',
                team_members: [
                  { name: 'John Smith', title: 'Partner', job_function: 'Partner', specialization: '', email: '', linkedin_url: '', profile_url: '', portfolio_companies: [] }
                ],
                portfolio_companies: [],
                firm_description: '',
                suggested_urls: [
                  { url: 'https://testvc.com/broken', reason: 'Team page', priority: 'high', expected_content: 'team' }
                ],
                has_more_content: false,
                load_more_selector: '',
                notes: ''
              })
            }
          }]
        });

      const result = await scrapeRecursively(
        'Test VC',
        'https://testvc.com',
        mockFetch,
        { maxDepth: 2, maxPages: 5, enableDeepProfiles: false, delayBetweenPages: 0 }
      );

      expect(result.success).toBe(true);
      expect(result.teamMembers).toHaveLength(1);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('Failed to fetch');
    });

    it('should not revisit already visited URLs', async () => {
      const mockFetch = vi.fn().mockResolvedValue(createMockHtml('Content page with information about the venture capital firm'));

      // Suggest the same URL multiple times
      mockQueuedLLMCall.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              page_type: 'homepage',
              content_quality: 'medium',
              team_members: [],
              portfolio_companies: [],
              firm_description: '',
              suggested_urls: [
                { url: 'https://testvc.com', reason: 'Homepage again', priority: 'high', expected_content: 'team' },
                { url: 'https://testvc.com/', reason: 'Homepage with slash', priority: 'high', expected_content: 'team' }
              ],
              has_more_content: false,
              load_more_selector: '',
              notes: ''
            })
          }
        }]
      });

      const result = await scrapeRecursively(
        'Test VC',
        'https://testvc.com',
        mockFetch,
        { maxDepth: 3, maxPages: 10, enableDeepProfiles: false, delayBetweenPages: 0 }
      );

      // Should only visit homepage once
      expect(result.stats.totalPagesVisited).toBe(1);
      // URLs are filtered before being added to queue, so urlsSkipped may be 0
      // The important thing is that we only visited 1 page
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should extract portfolio companies', async () => {
      const mockFetch = vi.fn().mockResolvedValue(createMockHtml('Portfolio page with all our investments and portfolio companies listed'));

      mockQueuedLLMCall.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              page_type: 'portfolio',
              content_quality: 'high',
              team_members: [],
              portfolio_companies: [
                { name: 'Startup A', description: 'AI company', sector: 'AI/ML', stage: 'Series A', url: 'https://startupa.com' },
                { name: 'Startup B', description: 'FinTech company', sector: 'FinTech', stage: 'Seed', url: 'https://startupb.com' }
              ],
              firm_description: '',
              suggested_urls: [],
              has_more_content: false,
              load_more_selector: '',
              notes: ''
            })
          }
        }]
      });

      const result = await scrapeRecursively(
        'Test VC',
        'https://testvc.com/portfolio',
        mockFetch,
        { maxDepth: 1, maxPages: 5, enableDeepProfiles: false, goal: 'portfolio' }
      );

      expect(result.success).toBe(true);
      expect(result.portfolioCompanies).toHaveLength(2);
      expect(result.portfolioCompanies[0].name).toBe('Startup A');
      expect(result.portfolioCompanies[0].sector).toBe('AI/ML');
    });
  });
});
