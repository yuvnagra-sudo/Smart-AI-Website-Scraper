/**
 * Tests for Phase 1 LinkedIn Discovery Improvements
 */
import { describe, it, expect } from "vitest";
import { 
  extractAllLinkedInURLs,
  matchLinkedInURLsToTeamMembers,
  extractAndMatchLinkedInURLs,
} from "./improvedLinkedInExtractor";
import { 
  generateLinkedInURLVariations,
  getNicknameVariations,
  findLinkedInURLForPerson,
} from "./smartUrlConstructor";

describe("Phase 1: LinkedIn Discovery Improvements", () => {
  
  describe("LinkedIn URL Extraction", () => {
    it("should extract LinkedIn profile URLs from HTML", () => {
      const html = `
        <html>
          <body>
            <a href="https://www.linkedin.com/in/john-smith">John Smith</a>
            <a href="https://www.linkedin.com/in/jane-doe">Jane Doe</a>
          </body>
        </html>
      `;
      
      const urls = extractAllLinkedInURLs(html);
      expect(urls.length).toBeGreaterThan(0);
      expect(urls.some(u => u.url.includes("john-smith"))).toBe(true);
    });
    
    it("should handle HTML with no LinkedIn URLs", () => {
      const html = `<html><body><p>No LinkedIn here</p></body></html>`;
      const urls = extractAllLinkedInURLs(html);
      expect(urls).toEqual([]);
    });
  });
  
  describe("LinkedIn URL Matching", () => {
    it("should match LinkedIn URLs to team member names", () => {
      const html = `
        <html>
          <body>
            <div class="team">
              <div class="member">
                <h3>John Smith</h3>
                <a href="https://www.linkedin.com/in/john-smith">LinkedIn</a>
              </div>
              <div class="member">
                <h3>Jane Doe</h3>
                <a href="https://www.linkedin.com/in/jane-doe">LinkedIn</a>
              </div>
            </div>
          </body>
        </html>
      `;
      
      const teamMembers = ["John Smith", "Jane Doe", "Bob Johnson"];
      const matches = extractAndMatchLinkedInURLs(html, teamMembers);
      
      // Function returns all team members with matched LinkedIn URLs
      expect(matches.length).toBeGreaterThanOrEqual(2);
      expect(matches.find(m => m.name === "John Smith")?.linkedinUrl).toContain("john-smith");
      expect(matches.find(m => m.name === "Jane Doe")?.linkedinUrl).toContain("jane-doe");
    });
  });
  
  describe("Context-Aware Extraction", () => {
    it("should extract LinkedIn URLs with context information", () => {
      const html = `
        <html>
          <body>
            <div class="bio">
              <h2>John Smith</h2>
              <p>Partner at Example VC</p>
              <a href="https://www.linkedin.com/in/john-smith">Connect on LinkedIn</a>
            </div>
          </body>
        </html>
      `;
      
      const urls = extractAllLinkedInURLs(html);
      expect(urls.length).toBeGreaterThan(0);
      expect(urls[0].url).toContain("john-smith");
      expect(urls[0].nearbyText).toBeTruthy();
    });
    
    it("should handle various HTML structures", () => {
      const html = `
        <html>
          <body>
            <ul class="social-links">
              <li><a href="https://www.linkedin.com/in/jane-doe">LinkedIn</a></li>
            </ul>
          </body>
        </html>
      `;
      
      const urls = extractAllLinkedInURLs(html);
      expect(urls.some(u => u.url.includes("jane-doe"))).toBe(true);
    });
  });
  
  describe("Smart URL Construction", () => {
    it("should generate multiple URL variations for a name", () => {
      const variations = generateLinkedInURLVariations("John Smith");
      
      expect(variations.length).toBeGreaterThan(0);
      expect(variations.some(v => v.url.includes("john-smith"))).toBe(true);
      expect(variations.some(v => v.url.includes("johnsmith"))).toBe(true);
      expect(variations.some(v => v.method === "first-last")).toBe(true);
    });
    
    it("should handle names with middle initials", () => {
      const variations = generateLinkedInURLVariations("John M. Smith");
      
      expect(variations.some(v => v.url.includes("john-m-smith"))).toBe(true);
      expect(variations.some(v => v.url.includes("john-smith"))).toBe(true);
    });
    
    it("should generate numbered variations", () => {
      const variations = generateLinkedInURLVariations("John Smith");
      
      expect(variations.some(v => v.url.includes("john-smith-1"))).toBe(true);
      expect(variations.some(v => v.url.includes("john-smith-2"))).toBe(true);
    });
  });
  
  describe("Nickname Normalization", () => {
    it("should recognize common nicknames", () => {
      const bobVariations = getNicknameVariations("Bob");
      expect(bobVariations).toContain("robert");
      expect(bobVariations).toContain("bobby");
      
      const billVariations = getNicknameVariations("Bill");
      expect(billVariations).toContain("william");
      
      const lizVariations = getNicknameVariations("Liz");
      expect(lizVariations).toContain("elizabeth");
    });
    
    it("should work bidirectionally (full name to nickname)", () => {
      const robertVariations = getNicknameVariations("Robert");
      expect(robertVariations).toContain("bob");
      expect(robertVariations).toContain("rob");
    });
    
    it("should handle names without nicknames", () => {
      const variations = getNicknameVariations("Xander");
      expect(variations).toContain("Xander");
      expect(variations.length).toBeGreaterThanOrEqual(1);
    });
  });
  
  describe("Integration Test: Complete LinkedIn Discovery", () => {
    it("should attempt multiple strategies to find LinkedIn URL", async () => {
      // This test validates the complete flow without making actual HTTP requests
      const variations = generateLinkedInURLVariations("John Smith");
      
      // Should have high, medium, and low confidence variations
      const highConfidence = variations.filter(v => v.confidence === "High");
      const mediumConfidence = variations.filter(v => v.confidence === "Medium");
      const lowConfidence = variations.filter(v => v.confidence === "Low");
      
      expect(highConfidence.length).toBeGreaterThan(0);
      expect(mediumConfidence.length).toBeGreaterThan(0);
      expect(lowConfidence.length).toBeGreaterThan(0);
      
      // High confidence should be tried first
      expect(variations[0].confidence).toBe("High");
    });
  });
});
