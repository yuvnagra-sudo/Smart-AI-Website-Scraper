import { describe, expect, it } from "vitest";
import { estimateEnrichmentCost } from "./costEstimation";
import { classifyDecisionMakerTier, filterDecisionMakers } from "./decisionMakerTiers";
import { calculateRecencyScore, extractInvestmentThesis, detectInvestmentPatterns, scorePortfolioByRecency } from "./portfolioIntelligence";

describe("Cost Estimation", () => {
  it("should calculate cost for 10 firms", () => {
    const estimate = estimateEnrichmentCost(10);
    
    expect(estimate.totalCost).toBeGreaterThan(0);
    expect(estimate.perFirmCost).toBeGreaterThan(0);
    expect(estimate.estimatedDuration).toBeTruthy();
    expect(estimate.estimatedTokens.input).toBeGreaterThan(0);
    expect(estimate.estimatedTokens.output).toBeGreaterThan(0);
  });

  it("should scale cost linearly with firm count", () => {
    const estimate10 = estimateEnrichmentCost(10);
    const estimate20 = estimateEnrichmentCost(20);
    
    expect(estimate20.totalCost).toBeCloseTo(estimate10.totalCost * 2, 1);
  });
});

describe("Decision Maker Tiers", () => {
  it("should classify Managing Partner as Tier 1", () => {
    const classification = classifyDecisionMakerTier("Managing Partner");
    
    expect(classification.tier).toBe("Tier 1");
    expect(classification.priority).toBe(1);
  });

  it("should classify Senior Associate as Tier 2", () => {
    const classification = classifyDecisionMakerTier("Senior Associate");
    
    expect(classification.tier).toBe("Tier 2");
    expect(classification.priority).toBe(2);
  });

  it("should classify Associate as Tier 3", () => {
    const classification = classifyDecisionMakerTier("Associate");
    
    expect(classification.tier).toBe("Tier 3");
    expect(classification.priority).toBe(3);
  });

  it("should exclude Marketing Manager", () => {
    const classification = classifyDecisionMakerTier("Marketing Manager");
    
    expect(classification.tier).toBe("Exclude");
    expect(classification.priority).toBe(4);
  });

  it("should filter out excluded roles", () => {
    const teamMembers = [
      { title: "Managing Partner", name: "John Doe" },
      { title: "Marketing Manager", name: "Jane Smith" },
      { title: "Associate", name: "Bob Johnson" },
      { title: "HR Director", name: "Alice Williams" },
    ];

    const filtered = filterDecisionMakers(teamMembers);
    
    expect(filtered).toHaveLength(2);
    expect(filtered.map(m => m.name)).toContain("John Doe");
    expect(filtered.map(m => m.name)).toContain("Bob Johnson");
    expect(filtered.map(m => m.name)).not.toContain("Jane Smith");
    expect(filtered.map(m => m.name)).not.toContain("Alice Williams");
  });
});

describe("Portfolio Intelligence", () => {
  it("should score very recent investments higher", () => {
    const today = new Date();
    const threeMonthsAgo = new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000);
    
    const { score, category } = calculateRecencyScore(threeMonthsAgo.toISOString());
    
    expect(score).toBeGreaterThan(80);
    expect(category).toBe("Very Recent");
  });

  it("should score old investments lower", () => {
    const threeYearsAgo = new Date();
    threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);
    
    const { score, category } = calculateRecencyScore(threeYearsAgo.toISOString());
    
    expect(score).toBeLessThan(30);
    expect(category).toBe("Old");
  });

  it("should extract investment thesis from portfolio", () => {
    const companies = [
      {
        companyName: "Company A",
        investmentDate: new Date().toISOString(),
        websiteUrl: "https://example.com",
        investmentNiche: ["SaaS", "B2B Software"],
        dataSourceUrl: "https://example.com",
        confidenceScore: "High",
      },
      {
        companyName: "Company B",
        investmentDate: new Date().toISOString(),
        websiteUrl: "https://example.com",
        investmentNiche: ["SaaS", "Fintech"],
        dataSourceUrl: "https://example.com",
        confidenceScore: "High",
      },
      {
        companyName: "Company C",
        investmentDate: new Date().toISOString(),
        websiteUrl: "https://example.com",
        investmentNiche: ["Healthcare", "AI/ML"],
        dataSourceUrl: "https://example.com",
        confidenceScore: "High",
      },
    ];

    const scoredCompanies = scorePortfolioByRecency(companies);
    const thesis = extractInvestmentThesis(scoredCompanies);
    
    expect(thesis.primaryFocus).toContain("SaaS");
    expect(thesis.investmentPace).toBe("Very Active");
    expect(thesis.recentTrends).toBeTruthy();
  });

  it("should detect investment patterns", () => {
    const companies = [
      {
        companyName: "Company A",
        investmentDate: new Date().toISOString(),
        websiteUrl: "https://example.com",
        investmentNiche: ["SaaS"],
        dataSourceUrl: "https://example.com",
        confidenceScore: "High",
        recencyScore: 95,
        recencyCategory: "Very Recent" as const,
      },
      {
        companyName: "Company B",
        investmentDate: new Date().toISOString(),
        websiteUrl: "https://example.com",
        investmentNiche: ["SaaS"],
        dataSourceUrl: "https://example.com",
        confidenceScore: "High",
        recencyScore: 90,
        recencyCategory: "Very Recent" as const,
      },
    ];

    const { patterns, confidence } = detectInvestmentPatterns(companies);
    
    expect(patterns.length).toBeGreaterThan(0);
    expect(confidence).toBe("Medium");
  });
});
