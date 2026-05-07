/**
 * Per-firm quality audit for agent-pipeline output.
 *
 * Two layers run for every firm:
 *
 *   1. Structural validation — pure regex/format checks. Free, deterministic.
 *      Catches the LLM violating its own format rules: emails that aren't emails,
 *      LinkedIn URLs that don't match the canonical shape, names with commas, etc.
 *
 *   2. LLM judge — sends the extracted fields plus a sample of the fetched page
 *      content back to a small model and asks "is each value supported by this
 *      content?" Returns a per-field accuracy score 0-100.
 *      Costs ~$0.001 per firm.
 *
 * Both run unconditionally per firm; the user gets a "Quality Audit" sheet in
 * the Excel output with per-row issues + per-field scores + a job-level summary.
 */

import { queuedLLMCall } from "./_core/llmQueue";
import type { AgentSection } from "./scraper/agentTypes";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  field: string;       // section key
  severity: "error" | "warning";
  message: string;     // 1-line explanation
}

export interface FieldAccuracyScore {
  field: string;       // section key
  score: number;       // 0-100, where 100 = clearly supported by page content
  reasoning: string;   // 1-line explanation
}

export interface QualityAuditResult {
  validationIssues: ValidationIssue[];
  llmFieldScores: FieldAccuracyScore[];
  llmOverallScore: number | null;   // average of llmFieldScores; null if LLM judge skipped
  llmReasoning: string;             // job-level 1-line summary
}

// ---------------------------------------------------------------------------
// 1. Structural validation
//
// Philosophy: report what looks off, don't gatekeep what's allowed.
//   - "error"   = data is structurally unusable (e.g., domain field has a protocol).
//   - "warning" = looks unusual or violates the prompt's format rule, worth a glance.
//
// Be lenient on the things real-world data does: regional LinkedIn subdomains,
// LinkedIn tracking query params, multi-token names ("van der Berg"), commas in
// employee counts ("1,000"), and Hunter's actual verification vocabulary.
// ---------------------------------------------------------------------------

// Email regex — accepts ASCII plus Latin-extended letters (à-ÿ, À-Ÿ) so names
// like josé@empresa.com don't trigger false warnings. Avoids the `u` flag for
// project tsconfig compatibility (no `target` set, so ES6 features are off).
const LATIN_LETTER = "a-zA-ZÀ-ÖØ-öø-ÿ";
const EMAIL_RE     = new RegExp(`^[${LATIN_LETTER}0-9._%+-]+@[${LATIN_LETTER}0-9.-]+\\.[${LATIN_LETTER}]{2,}$`);
// LinkedIn URLs allow optional regional subdomain (uk., de., ca., etc.) AND
// trailing query params/tracking (?trk=..., ?utm_source=...).
const LI_PERSON_RE = new RegExp(`^https?://([a-z]{2,4}\\.)?linkedin\\.com/in/[${LATIN_LETTER}0-9._-]+/?(\\?.*)?$`, "i");
const LI_COMPANY_RE= new RegExp(`^https?://([a-z]{2,4}\\.)?linkedin\\.com/(company|school|showcase)/[${LATIN_LETTER}0-9._-]+/?(\\?.*)?$`, "i");
const URL_RE       = /^https?:\/\/[^\s]+$/i;
const PHONE_RE     = /\d{3,}/;                       // contains at least 3 consecutive digits somewhere
const DOMAIN_RE    = new RegExp(`^[${LATIN_LETTER}0-9.-]+\\.[${LATIN_LETTER}]{2,}$`);
const YEAR_IN_VALUE_RE = /\b(18|19|20)\d{2}\b/;      // year appearing anywhere in the value
const PURE_YEAR_RE = /^\s*~?(c\.\s*)?(18|19|20)\d{2}s?\s*$/i; // "1985", "~1985", "c. 1985", "1980s"

/** Hunter's actual response vocabulary plus common synonyms. Lower-cased before compare. */
const VERIFICATION_STATUSES = new Set([
  "valid", "invalid", "accept_all", "webmail", "disposable", "unknown",
  // Synonyms / friendlier labels that the LLM might pass through
  "verified", "unverified", "risky", "deliverable", "undeliverable",
]);

const EMAIL_TYPES = new Set(["personal", "generic", "individual", "role", "role-based"]);

/** Apply structural checks to one row's extracted data. */
export function runStructuralValidation(
  data: Record<string, string>,
  sections: AgentSection[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const s of sections) {
    const raw = data[s.key];
    if (raw == null) continue;
    const value = String(raw).trim();
    if (!value) continue; // empty is allowed — that's the LLM saying "not found"

    const kl = (s.key + " " + s.label).toLowerCase();
    const keyL = s.key.toLowerCase();

    // ── Email fields ────────────────────────────────────────────────────────
    if (/\bemail\b/.test(kl) && !/email_(type|verification|verified|status)/.test(keyL)) {
      // Allow semicolon-separated lists (deterministic extractor sometimes joins multiple)
      const candidates = value.split(/[;,]/).map(v => v.trim()).filter(Boolean);
      const hasEmail = candidates.some(c => EMAIL_RE.test(c));
      if (!hasEmail) {
        // Warning, not error — the LLM may have written "not found" instead of "".
        issues.push({ field: s.key, severity: "warning", message: `No valid email found in value: "${trunc(value)}"` });
      }
    }

    // ── LinkedIn personal URL ───────────────────────────────────────────────
    if (/linkedin/.test(kl) && /(person|profile|individual)/.test(kl)) {
      if (!LI_PERSON_RE.test(value)) {
        issues.push({ field: s.key, severity: "warning", message: `Not a recognized linkedin.com/in/ URL: "${trunc(value)}"` });
      }
    }
    // ── LinkedIn company URL ────────────────────────────────────────────────
    else if (/linkedin/.test(kl) && /(company|firm|org|business)/.test(kl)) {
      if (!LI_COMPANY_RE.test(value)) {
        issues.push({ field: s.key, severity: "warning", message: `Not a recognized linkedin.com/company/ URL: "${trunc(value)}"` });
      }
    }
    // ── Generic LinkedIn URL field ──────────────────────────────────────────
    else if (/linkedin.?url\b/.test(kl) || (/linkedin/.test(kl) && !/(focus|presence)/.test(kl))) {
      if (!LI_PERSON_RE.test(value) && !LI_COMPANY_RE.test(value)) {
        issues.push({ field: s.key, severity: "warning", message: `Not a recognized linkedin.com URL: "${trunc(value)}"` });
      }
    }

    // ── First name / last name fields ───────────────────────────────────────
    // Only flag if the value clearly violates the contract (contains @ or digits or
    // is obviously a full sentence). Allow multi-token names like "van der Berg".
    if (/^(first|given).?name$|^(last|family|sur).?name$/.test(keyL)) {
      const tokenCount = value.split(/\s+/).length;
      if (/[@;]/.test(value) || /\d/.test(value)) {
        issues.push({ field: s.key, severity: "warning", message: `Name field contains @, digits, or semicolon: "${trunc(value)}"` });
      } else if (tokenCount > 4) {
        issues.push({ field: s.key, severity: "warning", message: `Name field has ${tokenCount} tokens — likely a full name or sentence rather than just first/last: "${trunc(value)}"` });
      }
    }

    // ── Title field — should not contain a full email or full URL ───────────
    if (/^title$|\btitle\b/.test(keyL) && !/page|window|html/.test(kl)) {
      if (EMAIL_RE.test(value) || URL_RE.test(value)) {
        issues.push({ field: s.key, severity: "warning", message: `Title looks like an email or URL: "${trunc(value)}"` });
      }
    }

    // ── Domain field ────────────────────────────────────────────────────────
    if (/^domain$/.test(keyL)) {
      if (value.includes("://") || value.includes("/")) {
        // This one stays an error — a domain with a protocol or path is unusable
        // for downstream tooling that expects a bare hostname.
        issues.push({ field: s.key, severity: "error", message: `Domain contains protocol or path (expected bare hostname like "acme.com"): "${trunc(value)}"` });
      } else if (!DOMAIN_RE.test(value)) {
        issues.push({ field: s.key, severity: "warning", message: `Doesn't look like a domain: "${trunc(value)}"` });
      }
    }

    // ── Phone field — at least 3 consecutive digits somewhere ───────────────
    if (/^phone\b|\bphone\b|\btel\b/.test(kl) && !/telecom|telephone.?(number)?$|cell.?phone.?(number)?$/.test(kl)) {
      if (!PHONE_RE.test(value)) {
        issues.push({ field: s.key, severity: "warning", message: `No 3+ digit sequence found — doesn't look like a phone number: "${trunc(value)}"` });
      }
    }

    // ── Founded / year — accept any value containing a year, plus prose like "Founded 1985" ──
    if (/^founded(_year)?$|^year_?founded$/.test(keyL)) {
      if (!PURE_YEAR_RE.test(value) && !YEAR_IN_VALUE_RE.test(value)) {
        issues.push({ field: s.key, severity: "warning", message: `No year found in value: "${trunc(value)}"` });
      }
    }

    // ── Employee count — strip commas, accept ranges, K/M, prose like "~200" ──
    if (/employee.?count|staff.?(count|size)|head.?count|team.?size/.test(keyL)) {
      const stripped = value.replace(/,/g, "");
      const looksNumeric = /\d/.test(stripped) && /^[<>~]?\s*\d+(\.\d+)?\s*[KkMm]?(\s*[-–~+]\s*\d+(\.\d+)?\s*[KkMm]?)?\s*(employees?|staff|people|\+)?\s*$/.test(stripped);
      const hasYearLikeAlone = /^(19|20)\d{2}$/.test(stripped);
      if (!looksNumeric || hasYearLikeAlone) {
        // Only warn if it really doesn't look numeric. Most prose like "Approximately 200"
        // contains a number we can pull out — accept it.
        if (!/\d{1,7}/.test(stripped)) {
          issues.push({ field: s.key, severity: "warning", message: `No number found — doesn't look like a count: "${trunc(value)}"` });
        }
      }
    }

    // ── Email type ──────────────────────────────────────────────────────────
    if (/^email_type$/.test(keyL)) {
      if (!EMAIL_TYPES.has(value.toLowerCase())) {
        issues.push({ field: s.key, severity: "warning", message: `Expected "personal" or "generic": "${trunc(value)}"` });
      }
    }

    // ── Email verification status ───────────────────────────────────────────
    if (/email_(verification|verified)_?status/.test(keyL)) {
      if (!VERIFICATION_STATUSES.has(value.toLowerCase())) {
        issues.push({ field: s.key, severity: "warning", message: `Unexpected verification status (Hunter returns valid/invalid/accept_all/webmail/disposable/unknown): "${trunc(value)}"` });
      }
    }

    // ── Markdown / HTML leakage in any field ────────────────────────────────
    // Markdown links: [text](url) — clear LLM rule violation.
    if (/\[[^\]]+\]\([^)]+\)/.test(value)) {
      issues.push({ field: s.key, severity: "warning", message: `Contains a markdown link [text](url)` });
    }
    // HTML tags: <div>, <br />, etc. Avoid false-positive on "< 100" by requiring no space.
    if (/<\/?[a-z][a-z0-9]*\s*\/?>/i.test(value)) {
      issues.push({ field: s.key, severity: "warning", message: `Contains HTML markup` });
    }
    // Named HTML entities (&amp;, &nbsp;) — numeric entities (&#39;) handled separately.
    if (/&(amp|lt|gt|quot|apos|nbsp|copy|reg|trade|hellip|mdash|ndash|rsquo|lsquo|rdquo|ldquo);/i.test(value)) {
      issues.push({ field: s.key, severity: "warning", message: `Contains HTML entities` });
    }
    // URL encoding: %XX where XX is two hex digits — common LLM leakage from raw URLs.
    if (/%[0-9A-F]{2}/i.test(value) && !/percent|%\s/.test(value.toLowerCase())) {
      issues.push({ field: s.key, severity: "warning", message: `Contains URL encoding (%XX)` });
    }
  }

  return issues;
}

function trunc(s: string, n = 80): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// ---------------------------------------------------------------------------
// 2. LLM judge
// ---------------------------------------------------------------------------

const JUDGE_MODEL = "gpt-5.4-nano";
const MAX_PAGE_CHARS = 6000;     // truncate raw page sample to keep cost predictable
const MAX_FIELDS_TO_AUDIT = 12;  // skip if user defined a huge schema

const JUDGE_SYSTEM_PROMPT = `You are a quality auditor reviewing data extracted from a company website.

For each extracted (field, value) pair, judge whether the value is SUPPORTED by the provided page content.

Score 0-100:
  90-100 — Value appears verbatim or paraphrased on the page.
  60-89  — Value is consistent with what the page implies, even if not stated directly.
  30-59  — Value is plausible but not really supported by the page text.
  0-29   — Value contradicts the page or has no support at all (likely hallucination).

If a field's value is empty (""), skip it — score 100 with reasoning "empty (no claim made)".

Be strict. If you can't see the value (or a clear paraphrase) in the page text, it's not supported.

Return ONLY valid JSON: { "overall_summary": "...", "scores": [{ "field": "...", "score": N, "reasoning": "..." }] }`;

const JUDGE_RESPONSE_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "quality_audit",
    strict: true,
    schema: {
      type: "object",
      properties: {
        overall_summary: { type: "string" },
        scores: {
          type: "array",
          items: {
            type: "object",
            properties: {
              field: { type: "string" },
              score: { type: "number" },
              reasoning: { type: "string" },
            },
            required: ["field", "score", "reasoning"],
            additionalProperties: false,
          },
        },
      },
      required: ["overall_summary", "scores"],
      additionalProperties: false,
    },
  },
};

/** Run the LLM judge over the extracted data using a sample of the fetched page text. */
export async function runLLMQualityAudit(
  data: Record<string, string>,
  sections: AgentSection[],
  pageContents: string[],
): Promise<{ overallScore: number | null; reasoning: string; fieldScores: FieldAccuracyScore[] }> {
  // Skip if there's nothing to judge
  const fieldsToAudit = sections.filter(s => data[s.key]?.trim()).slice(0, MAX_FIELDS_TO_AUDIT);
  if (fieldsToAudit.length === 0) {
    return { overallScore: null, reasoning: "No non-empty fields to audit", fieldScores: [] };
  }
  if (pageContents.length === 0) {
    return { overallScore: null, reasoning: "No page content available to judge against", fieldScores: [] };
  }

  // Concatenate top 1-2 pages, truncated
  const combined = pageContents.slice(0, 2).join("\n\n---\n\n").slice(0, MAX_PAGE_CHARS);

  const userPrompt = [
    "## Page Content (sample)",
    combined,
    "",
    "## Extracted Fields",
    ...fieldsToAudit.map(s => `- ${s.key}: ${JSON.stringify(data[s.key] || "")}`),
  ].join("\n");

  try {
    const response = await queuedLLMCall({
      model: JUDGE_MODEL,
      messages: [
        { role: "system", content: JUDGE_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      response_format: JUDGE_RESPONSE_SCHEMA,
    });

    const content = response.choices[0]?.message?.content;
    const parsed = JSON.parse(typeof content === "string" ? content : "{}");

    const fieldScores: FieldAccuracyScore[] = (parsed.scores ?? []).map((s: any) => ({
      field: String(s.field),
      score: Math.max(0, Math.min(100, Math.round(Number(s.score) || 0))),
      reasoning: String(s.reasoning || ""),
    }));

    const overallScore = fieldScores.length > 0
      ? Math.round(fieldScores.reduce((sum, f) => sum + f.score, 0) / fieldScores.length)
      : null;

    return {
      overallScore,
      reasoning: String(parsed.overall_summary || ""),
      fieldScores,
    };
  } catch (err) {
    return {
      overallScore: null,
      reasoning: `LLM judge failed: ${err instanceof Error ? err.message : String(err)}`,
      fieldScores: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Combined runner
// ---------------------------------------------------------------------------

export async function runQualityAudit(
  data: Record<string, string>,
  sections: AgentSection[],
  pageContents: string[],
): Promise<QualityAuditResult> {
  const validationIssues = runStructuralValidation(data, sections);
  const judge = await runLLMQualityAudit(data, sections, pageContents);
  return {
    validationIssues,
    llmFieldScores: judge.fieldScores,
    llmOverallScore: judge.overallScore,
    llmReasoning: judge.reasoning,
  };
}
