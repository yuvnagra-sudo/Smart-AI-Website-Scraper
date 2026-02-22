import { describe, it, expect } from "vitest";
import { classifyDecisionMakerTier } from "./decisionMakerTiers";

describe("Decision Maker Tier Classification", () => {
  describe("Tier 1 - Primary Decision Makers", () => {
    it("should classify standard partner titles as Tier 1", () => {
      expect(classifyDecisionMakerTier("Managing Partner").tier).toBe("Tier 1");
      expect(classifyDecisionMakerTier("General Partner").tier).toBe("Tier 1");
      expect(classifyDecisionMakerTier("Partner").tier).toBe("Tier 1");
      expect(classifyDecisionMakerTier("Principal").tier).toBe("Tier 2"); // Principal is now Tier 2 (senior deal team)
    });

    it("should classify partner variations as Tier 1", () => {
      expect(classifyDecisionMakerTier("Founding Partner").tier).toBe("Tier 1");
      expect(classifyDecisionMakerTier("Senior Partner").tier).toBe("Tier 1");
      expect(classifyDecisionMakerTier("Investment Partner").tier).toBe("Tier 1");
      // Venture Partner is excluded (post-investment role)
      expect(classifyDecisionMakerTier("Venture Partner").tier).toBe("Exclude");
    });

    it("should classify managing director as Tier 1", () => {
      expect(classifyDecisionMakerTier("Managing Director").tier).toBe("Tier 1");
      expect(classifyDecisionMakerTier("MD").tier).toBe("Tier 1");
    });

    it("should handle partner titles with extra text", () => {
      expect(classifyDecisionMakerTier("Partner at XYZ Ventures").tier).toBe("Tier 1");
      expect(classifyDecisionMakerTier("General Partner, ABC Capital").tier).toBe("Tier 1");
    });
  });

  describe("Tier 2 - Influencers", () => {
    it("should classify senior associates as Tier 2", () => {
      expect(classifyDecisionMakerTier("Senior Associate").tier).toBe("Tier 2");
      expect(classifyDecisionMakerTier("Vice President").tier).toBe("Tier 2");
      expect(classifyDecisionMakerTier("VP").tier).toBe("Tier 2");
    });
  });

  describe("Tier 3 - Gatekeepers", () => {
    it("should classify associates and analysts as Tier 3", () => {
      expect(classifyDecisionMakerTier("Associate").tier).toBe("Tier 3");
      expect(classifyDecisionMakerTier("Analyst").tier).toBe("Tier 3");
      expect(classifyDecisionMakerTier("Investment Associate").tier).toBe("Tier 3");
    });
  });

  describe("Unknown Investment Titles", () => {
    it("should default unknown investment-related titles to Tier 3", () => {
      // These contain investment keywords but don't match specific patterns
      // Note: "Investment Team Lead" is now Tier 1 due to department-based classification
      expect(classifyDecisionMakerTier("Investment Team Lead").tier).toBe("Tier 1");
      expect(classifyDecisionMakerTier("Venture Scout").tier).toBe("Tier 3");
      expect(classifyDecisionMakerTier("Portfolio Manager").tier).toBe("Tier 3");
      expect(classifyDecisionMakerTier("Deal Sourcing Lead").tier).toBe("Tier 3");
      expect(classifyDecisionMakerTier("Fund Manager").tier).toBe("Tier 3");
    });

    it("should handle partner-like titles that don't match exact patterns", () => {
      // Equity Partner is investment-focused
      expect(classifyDecisionMakerTier("Equity Partner").tier).toBe("Tier 1");
      // Limited Partner is excluded (passive investor, not deal sourcing)
      expect(classifyDecisionMakerTier("Limited Partner").tier).toBe("Exclude");
    });
  });

  describe("Exclude - Non-Investment Roles", () => {
    it("should exclude operations and admin roles", () => {
      expect(classifyDecisionMakerTier("Chief Operating Officer").tier).toBe("Exclude");
      expect(classifyDecisionMakerTier("Office Manager").tier).toBe("Exclude");
      expect(classifyDecisionMakerTier("Executive Assistant").tier).toBe("Exclude");
    });

    it("should exclude marketing and communications roles", () => {
      expect(classifyDecisionMakerTier("Marketing Director").tier).toBe("Exclude");
      expect(classifyDecisionMakerTier("Communications Manager").tier).toBe("Exclude");
    });

    it("should exclude finance and legal roles", () => {
      expect(classifyDecisionMakerTier("CFO").tier).toBe("Exclude");
      expect(classifyDecisionMakerTier("General Counsel").tier).toBe("Exclude");
      expect(classifyDecisionMakerTier("Controller").tier).toBe("Exclude");
    });

    it("should exclude clearly non-investment titles", () => {
      expect(classifyDecisionMakerTier("Software Engineer").tier).toBe("Exclude");
      expect(classifyDecisionMakerTier("HR Manager").tier).toBe("Exclude");
      expect(classifyDecisionMakerTier("Receptionist").tier).toBe("Exclude");
    });
  });

  describe("Case Insensitivity", () => {
    it("should handle different cases correctly", () => {
      expect(classifyDecisionMakerTier("MANAGING PARTNER").tier).toBe("Tier 1");
      expect(classifyDecisionMakerTier("managing partner").tier).toBe("Tier 1");
      expect(classifyDecisionMakerTier("Managing Partner").tier).toBe("Tier 1");
    });
  });

  describe("Priority Ordering", () => {
    it("should assign correct priorities", () => {
      expect(classifyDecisionMakerTier("Partner").priority).toBe(1);
      expect(classifyDecisionMakerTier("Senior Associate").priority).toBe(2);
      expect(classifyDecisionMakerTier("Associate").priority).toBe(3);
      expect(classifyDecisionMakerTier("CFO").priority).toBe(999); // Exclude priority is 999
    });
  });
});
