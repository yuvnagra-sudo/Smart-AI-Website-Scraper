/**
 * vcSections.ts — VC firm enrichment defined as AgentSection[]
 *
 * These are the flat scalar fields that scrapeUrl() extracts from the agent loop.
 * Team members and portfolio companies are NOT flat fields — they are extracted
 * via the onPageFetched callback using specialized extractors.
 */

import type { AgentSection } from "./agentScraper";

/** Flat VC firm-level sections passed to scrapeUrl(). */
export const VC_FLAT_SECTIONS: AgentSection[] = [
  {
    key: "description",
    label: "Firm Description",
    desc: "One-paragraph description of what this VC/investment firm does, who they back, and what makes them distinctive",
  },
  {
    key: "investorType",
    label: "Investor Type",
    desc: "Type(s) of investor — one or more of: Venture Capital, Micro VC, Angel Network, Private Equity, Corporate VC, Family Office, Growth Equity, Accelerator, Hedge Fund. Comma-separated if multiple.",
  },
  {
    key: "investmentStages",
    label: "Investment Stages",
    desc: "Investment stages the firm focuses on — e.g. Pre-Seed, Seed, Series A, Series B, Series C, Growth, Late Stage. Comma-separated.",
  },
  {
    key: "investmentNiches",
    label: "Investment Niches / Sectors",
    desc: "Industry sectors and technology niches the firm invests in — e.g. AI/ML, SaaS, FinTech, HealthTech, CleanTech, Web3, B2B Software, Consumer. Comma-separated.",
  },
  {
    key: "aum",
    label: "AUM / Fund Size",
    desc: "Assets under management or fund size if explicitly mentioned on the site (e.g. '$500M fund', '$1.2B AUM'). Leave blank if not found.",
  },
  {
    key: "foundedYear",
    label: "Founded Year",
    desc: "4-digit year the firm was founded. Leave blank if not found.",
  },
  {
    key: "headquarters",
    label: "Headquarters",
    desc: "City and country where the firm is headquartered (e.g. 'San Francisco, USA', 'London, UK'). Leave blank if not found.",
  },
];

/**
 * System prompt used when running the agent loop for VC firm enrichment.
 * Focuses the agent on firm-level data and suppresses generic extraction noise.
 */
export const VC_FLAT_SYSTEM_PROMPT = `You are a research assistant extracting structured data about a venture capital or investment firm from their website.

Focus on firm-level facts: what they invest in, their stage focus, fund size, founding year, and headquarters.
Do NOT include individual team member details or portfolio company names — those are captured separately.
Extract values precisely as stated on the website. If a field cannot be found on the page, leave it blank rather than guessing.
For list fields (investorType, investmentStages, investmentNiches), return comma-separated values.`;

/** URL patterns that suggest a page is a team/people page. */
export const TEAM_PAGE_PATTERN = /\/(team|people|leadership|executives|staff|management|our[-_]team|meet[-_]the[-_]team|founders|partners|about\/team|company\/team)\b/i;

/** URL patterns that suggest a page is a portfolio/investments page. */
export const PORTFOLIO_PAGE_PATTERN = /\/(portfolio|investments|companies|ventures|backed|our[-_]companies|portfolio[-_]companies)\b/i;
