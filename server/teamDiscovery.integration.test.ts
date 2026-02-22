/**
 * Integration test for team member discovery
 * Tests the full pipeline: website scraping → LLM extraction → tier classification → filtering
 */

import { describe, it, expect } from "vitest";
import { VCEnrichmentService } from "./vcEnrichment";
import { classifyDecisionMakerTier } from "./decisionMakerTiers";

describe("Team Member Discovery Integration", () => {
  // Use a longer timeout for real website scraping
  const TIMEOUT = 60000;

  it("should extract team members from a real VC website", async () => {
    const enricher = new VCEnrichmentService();
    
    // Test with a16z (Andreessen Horowitz) - well-known VC with public team page
    const companyName = "Andreessen Horowitz";
    const websiteUrl = "https://a16z.com";
    const description = "Venture capital firm investing in bold entrepreneurs building the future";
    
    console.log(`\n[Integration Test] Testing team extraction for ${companyName}...`);
    
    const result = await enricher.enrichVCFirm(
      companyName,
      websiteUrl,
      description,
      (msg) => console.log(`[Integration Test] ${msg}`)
    );
    
    console.log(`\n[Integration Test] Results:`);
    console.log(`- Website verified: ${result.websiteVerified}`);
    console.log(`- Team members found: ${result.teamMembers.length}`);
    
    // Log first 5 team members with their tier classification
    console.log(`\n[Integration Test] Sample team members:`);
    result.teamMembers.slice(0, 5).forEach((member, idx) => {
      const tier = classifyDecisionMakerTier(member.title);
      console.log(`  ${idx + 1}. ${member.name}`);
      console.log(`     Title: "${member.title}"`);
      console.log(`     Tier: ${tier.tier} (${tier.description})`);
      console.log(`     LinkedIn: ${member.linkedinUrl || "Not found"}`);
    });
    
    // Assertions
    expect(result.websiteVerified).toBe(true);
    expect(result.teamMembers.length).toBeGreaterThan(0);
    
    // Check that we have at least some Tier 1 members (partners)
    const tier1Members = result.teamMembers.filter(m => {
      const tier = classifyDecisionMakerTier(m.title);
      return tier.tier === "Tier 1";
    });
    
    console.log(`\n[Integration Test] Tier 1 members: ${tier1Members.length}`);
    expect(tier1Members.length).toBeGreaterThan(0);
    
    // Check that titles are being extracted (not empty)
    const membersWithTitles = result.teamMembers.filter(m => m.title && m.title.length > 0);
    expect(membersWithTitles.length).toBe(result.teamMembers.length);
    
  }, TIMEOUT);

  it("should classify various VC titles correctly", () => {
    // Test common VC titles that should be included
    const testCases = [
      { title: "General Partner", expectedTier: "Tier 1" },
      { title: "Managing Partner", expectedTier: "Tier 1" },
      { title: "Partner", expectedTier: "Tier 1" },
      { title: "Principal", expectedTier: "Tier 1" },
      { title: "Senior Associate", expectedTier: "Tier 2" },
      { title: "Vice President", expectedTier: "Tier 2" },
      { title: "Associate", expectedTier: "Tier 3" },
      { title: "Analyst", expectedTier: "Tier 3" },
      { title: "Investment Manager", expectedTier: "Tier 3" },
    ];
    
    testCases.forEach(({ title, expectedTier }) => {
      const result = classifyDecisionMakerTier(title);
      expect(result.tier).toBe(expectedTier);
    });
  });

  it("should handle tier filtering correctly", () => {
    const mockTeamMembers = [
      { name: "Alice", title: "General Partner" },
      { name: "Bob", title: "Senior Associate" },
      { name: "Charlie", title: "Associate" },
      { name: "David", title: "CFO" },
    ];
    
    // Simulate tier1-2 filter (which now includes Tier 3)
    const filtered = mockTeamMembers.filter(member => {
      const tier = classifyDecisionMakerTier(member.title);
      return tier.tier === "Tier 1" || tier.tier === "Tier 2" || tier.tier === "Tier 3";
    });
    
    // Should include Alice (Tier 1), Bob (Tier 2), Charlie (Tier 3)
    // Should exclude David (CFO = Exclude)
    expect(filtered.length).toBe(3);
    expect(filtered.map(m => m.name)).toEqual(["Alice", "Bob", "Charlie"]);
  });
});
