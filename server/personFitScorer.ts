/**
 * AI Person-Fit Scorer + Buying Committee Identification
 *
 * Given a user's outreach context and a list of extracted team members,
 * scores each person for relevance and identifies their likely buying
 * committee role (Decision Maker, Technical Buyer, Financial Buyer,
 * Influencer, Gatekeeper).
 *
 * This is FIT scoring (does this person match the target persona?),
 * not INTENT scoring (is this person ready to buy?). We only have
 * website-scraped data, not CRM or behavioral signals.
 */

import { queuedLLMCall } from "./_core/llmQueue";
import { findPersonByName } from "./nameNormalization";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FitScore {
  name: string;
  score: number;            // 0-100
  reasoning: string;        // 1-2 sentences
  buyingRole: string | null; // "Decision Maker" | "Technical Buyer" | "Financial Buyer" | "Influencer" | "Gatekeeper" | null
}

export interface OutreachContext {
  context: string;          // What you're offering
  persona: string;          // Who you want to reach
  exclusions: string;       // Who to exclude
}

interface TeamMemberInput {
  name: string;
  title: string;
  jobFunction?: string;
  specialization?: string;
  background?: string;
  investmentFocus?: string;
  yearsExperience?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_MEMBERS_PER_CHUNK = 80;
const MODEL = "gpt-5.4-mini";

const SYSTEM_PROMPT = `You are a B2B sales intelligence analyst. Given a user's outreach context and a list of people at a company, do two things:

1. SCORE each person 0-100 for outreach relevance:
   80-100: Strong role match, primary outreach target
   50-79: Adjacent role, could influence or champion the decision
   20-49: Tangentially related, not a primary target
   0-19: Unrelated or matches exclusion criteria

2. IDENTIFY each person's likely buying committee role for this specific offer:
   - "Decision Maker" — has authority to approve the purchase
   - "Technical Buyer" — evaluates whether the solution works technically
   - "Financial Buyer" — controls budget, approves spend
   - "Influencer" — shapes opinions, can champion or block internally
   - "Gatekeeper" — controls access to decision makers
   - null — no clear role in this buying decision

Rules:
- Score and label ONLY based on the data provided. Do not invent information.
- A company may have 0-5 relevant buying committee members. Not everyone is relevant.
- If someone matches the exclusion criteria, give them score 0 with buyingRole null.
- Score people RELATIVE to each other — the best-fit person should have the highest score.
- The list may include a "General Contact" entry with a generic email (info@, contact@).
  Score it 30-40 (Low Fit) with buyingRole "Gatekeeper". This means: if the only named
  people are terrible ICP fits (score <30), the generic email should outrank them because
  it might get forwarded to the right person. But any decent ICP fit should outrank the generic email.`;

const RESPONSE_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "fit_scores",
    strict: true,
    schema: {
      type: "object",
      properties: {
        scores: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              score: { type: "number" },
              reasoning: { type: "string" },
              buyingRole: { type: ["string", "null"] },
            },
            required: ["name", "score", "reasoning", "buyingRole"],
            additionalProperties: false,
          },
        },
      },
      required: ["scores"],
      additionalProperties: false,
    },
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatMemberForPrompt(m: TeamMemberInput, idx: number): string {
  const parts = [`${idx + 1}. ${m.name}`];
  if (m.title) parts.push(`Title: ${m.title}`);
  if (m.jobFunction) parts.push(`Function: ${m.jobFunction}`);
  if (m.specialization) parts.push(`Specialization: ${m.specialization}`);
  if (m.background) parts.push(`Background: ${m.background}`);
  if (m.investmentFocus) parts.push(`Focus: ${m.investmentFocus}`);
  if (m.yearsExperience) parts.push(`Experience: ${m.yearsExperience}`);
  return parts.join(" | ");
}

function buildUserPrompt(
  members: TeamMemberInput[],
  firm: { companyName: string; description?: string },
  outreach: OutreachContext,
): string {
  const lines: string[] = [];

  lines.push("## My Outreach Context");
  lines.push(outreach.context || "(not provided)");
  lines.push("");
  lines.push("## Target Persona");
  lines.push(outreach.persona || "(not provided)");
  lines.push("");
  if (outreach.exclusions) {
    lines.push("## Exclusion Criteria");
    lines.push(outreach.exclusions);
    lines.push("");
  }
  lines.push(`## Company: ${firm.companyName}`);
  if (firm.description) lines.push(firm.description);
  lines.push("");
  lines.push(`## Team Members (${members.length})`);
  for (let i = 0; i < members.length; i++) {
    lines.push(formatMemberForPrompt(members[i], i));
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Core scoring function
// ---------------------------------------------------------------------------

async function scoreChunk(
  members: TeamMemberInput[],
  firm: { companyName: string; description?: string },
  outreach: OutreachContext,
): Promise<FitScore[]> {
  const userPrompt = buildUserPrompt(members, firm, outreach);

  const response = await queuedLLMCall({
    model: MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    response_format: RESPONSE_SCHEMA,
  });

  const content = response.choices[0]?.message?.content;
  const parsed = JSON.parse(typeof content === "string" ? content : "{}");
  const scores: FitScore[] = parsed.scores ?? [];

  // Validate and clamp scores
  return scores.map(s => ({
    name: s.name,
    score: Math.max(0, Math.min(100, Math.round(s.score))),
    reasoning: s.reasoning || "",
    buyingRole: s.buyingRole || null,
  }));
}

// ---------------------------------------------------------------------------
// Title-heuristic fallback ranker
// ---------------------------------------------------------------------------

/**
 * Deterministic title-based ranker. Used when the user has not provided
 * an outreach context or target persona — we still want to give them a
 * "who to call first" answer based on seniority and likely buying role.
 *
 * Scores follow the same 0-100 scale as the LLM scorer so downstream
 * consumers (Excel sort, UI sort) work identically.
 */
function scoreByTitleHeuristic(members: TeamMemberInput[]): FitScore[] {
  const TITLE_RULES: Array<{ re: RegExp; score: number; role: string | null; reason: string }> = [
    // Top-level decision makers
    { re: /\bCEO\b|chief executive|\bowner\b|\bpresident\b|\bfounder\b|co[\s-]?founder|managing (partner|director|principal)/i,
      score: 90, role: "Decision Maker", reason: "Top-level executive — primary outreach target by seniority" },
    // Financial leadership
    { re: /\bCFO\b|chief financial|\bcontroller\b|\btreasurer\b|VP\s+(of\s+)?finance|director of finance|finance director|head of finance/i,
      score: 80, role: "Financial Buyer", reason: "Owns budget — typical financial approver" },
    // Technical leadership
    { re: /\bCTO\b|chief technology|\bCIO\b|chief information|VP\s+(of\s+)?(engineering|technology|product|IT)|head of (engineering|technology|product|IT)|director of (engineering|technology|IT)/i,
      score: 80, role: "Technical Buyer", reason: "Technical leadership — evaluates fit and feasibility" },
    // Other C-suite
    { re: /\bCOO\b|chief operating|\bCMO\b|chief marketing|\bCRO\b|chief revenue|\bCSO\b|chief strategy|\bCHRO\b|chief (people|human|hr)|\bCISO\b|chief security|chief [a-z]+ officer/i,
      score: 80, role: "Decision Maker", reason: "C-suite executive — likely decision maker in their function" },
    // VP-level
    { re: /\b(SVP|EVP|VP)\b|vice president|senior vice president|executive vice president/i,
      score: 70, role: "Decision Maker", reason: "VP-level — typically holds budget for their function" },
    // Partner (law / consulting / accounting / VC firms)
    { re: /\bpartner\b/i,
      score: 70, role: "Decision Maker", reason: "Partner — senior leadership, typically holds budget authority" },
    // Director / Head of
    { re: /\bdirector\b|\bhead of\b/i,
      score: 60, role: "Influencer", reason: "Director-level — strong influencer, often champion" },
    // Generic / gatekeeper entry
    { re: /general contact|^info$|^contact$|generic email|reception/i,
      score: 30, role: "Gatekeeper", reason: "Generic contact — may forward but not the decision maker" },
    // Manager / Lead
    { re: /\b(senior )?manager\b|\blead\b|\bteam lead\b|\bprincipal\b/i,
      score: 45, role: "Influencer", reason: "Mid-level — useful contact but not typical decision maker" },
    // Senior IC
    { re: /\bsenior\b|\bstaff\b|\barchitect\b/i,
      score: 35, role: null, reason: "Senior individual contributor — limited buying authority" },
  ];

  return members.map((m): FitScore => {
    const haystack = `${m.title || ""} ${m.jobFunction || ""}`.trim();
    if (!haystack && (!m.name || /general contact|generic|^info|^contact/i.test(m.name))) {
      return { name: m.name, score: 30, reasoning: "Generic contact — may forward but not the decision maker", buyingRole: "Gatekeeper" };
    }
    for (const rule of TITLE_RULES) {
      if (rule.re.test(haystack) || rule.re.test(m.name || "")) {
        return { name: m.name, score: rule.score, reasoning: rule.reason, buyingRole: rule.role };
      }
    }
    return { name: m.name, score: 25, reasoning: "Individual contributor or unspecified role — low priority for outreach", buyingRole: null };
  });
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

/**
 * Score team members for outreach fit and identify buying committee roles.
 *
 * If outreach context or target persona is provided, runs the LLM-based scorer.
 * Otherwise falls back to a deterministic title-based ranker so users always
 * get a "who to call first" signal.
 *
 * Returns null only if the input is empty or the LLM call throws.
 */
export async function scoreTeamMemberFit(
  members: TeamMemberInput[],
  firm: { companyName: string; description?: string },
  outreach: OutreachContext,
): Promise<FitScore[] | null> {
  if (members.length === 0) return null;
  if (!outreach.context && !outreach.persona) {
    return scoreByTitleHeuristic(members);
  }

  try {
    let allScores: FitScore[] = [];

    if (members.length <= MAX_MEMBERS_PER_CHUNK) {
      // Single call for small teams
      allScores = await scoreChunk(members, firm, outreach);
    } else {
      // Chunk large teams into parallel calls
      const chunks: TeamMemberInput[][] = [];
      for (let i = 0; i < members.length; i += MAX_MEMBERS_PER_CHUNK) {
        chunks.push(members.slice(i, i + MAX_MEMBERS_PER_CHUNK));
      }

      console.log(`[personFitScorer] Scoring ${members.length} members in ${chunks.length} chunks for "${firm.companyName}"`);

      const results = await Promise.allSettled(
        chunks.map(chunk => scoreChunk(chunk, firm, outreach)),
      );

      for (const result of results) {
        if (result.status === "fulfilled") {
          allScores.push(...result.value);
        }
      }
    }

    console.log(
      `[personFitScorer] Scored ${allScores.length}/${members.length} members for "${firm.companyName}". ` +
      `High fit: ${allScores.filter(s => s.score >= 80).length}, ` +
      `Committee roles: ${allScores.filter(s => s.buyingRole).length}`,
    );

    return allScores;
  } catch (err) {
    console.error(`[personFitScorer] Scoring failed for "${firm.companyName}" (non-fatal):`, err);
    return null;
  }
}

/**
 * Look up a fit score for a specific team member by name.
 * Uses fuzzy name matching to handle minor variations.
 */
export function findFitScore(
  scores: FitScore[],
  memberName: string,
): FitScore | undefined {
  // Exact match first
  const exact = scores.find(s => s.name.toLowerCase() === memberName.toLowerCase());
  if (exact) return exact;

  // Fuzzy match via nameNormalization
  const fuzzy = findPersonByName(scores, memberName);
  return fuzzy ?? undefined;
}

/**
 * Derive fit tier label from numeric score.
 */
export function getFitTier(score: number): "High Fit" | "Medium Fit" | "Low Fit" | "No Fit" {
  if (score >= 80) return "High Fit";
  if (score >= 50) return "Medium Fit";
  if (score >= 20) return "Low Fit";
  return "No Fit";
}
