/**
 * Pre-LLM Structured Data Extraction
 *
 * Extracts machine-readable data from HTML BEFORE sending to the LLM.
 * This harvests "low-hanging fruit" that is 100% deterministic and avoids
 * wasting tokens + risking hallucination on data the page already provides.
 *
 * Three extraction passes:
 *   1. JSON-LD / Schema.org metadata (confidence 0.99)
 *   2. CSS selector heuristics (confidence 0.85–0.90)
 *   3. Deterministic regex patterns (LinkedIn URLs, emails, phones)
 *
 * Elevated from comprehensiveTeamExtraction.ts into the main pipeline.
 */

import * as cheerio from "cheerio";
import type { AgentSection, FieldResult, FieldResultMap } from "./agentScraper";
import { getProfile } from "./agentConfig";

// ---------------------------------------------------------------------------
// Confidence levels — sourced from active agent profile
// ---------------------------------------------------------------------------

const cl = getProfile().confidenceLevels;

export const CONFIDENCE = {
  JSON_LD: cl.json_ld ?? 0.99,
  MICRODATA: cl.microdata ?? 0.95,
  CSS_CARD: cl.css_card ?? 0.90,
  CSS_HEADING_PAIR: cl.css_heading_pair ?? 0.80,
  REGEX_DETERMINISTIC: cl.regex_deterministic ?? 0.92,
  DIRECTORY_FIELD: cl.directory_field ?? 0.95,
} as const;

// ---------------------------------------------------------------------------
// JSON-LD / Schema.org Extraction
// ---------------------------------------------------------------------------

interface StructuredEntity {
  type: string;              // "Organization", "Person", "LocalBusiness", etc.
  name?: string;
  jobTitle?: string;
  url?: string;
  email?: string;
  telephone?: string;
  description?: string;
  foundingDate?: string;
  numberOfEmployees?: string;
  address?: string;
  sameAs?: string[];         // Social profile URLs
  employee?: StructuredEntity[];
  founder?: StructuredEntity[];
  [key: string]: unknown;
}

function extractJsonLD(html: string): StructuredEntity[] {
  const entities: StructuredEntity[] = [];
  const $ = cheerio.load(html);

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).html() ?? "";
      const data = JSON.parse(raw);
      const items: unknown[] = Array.isArray(data) ? data : [data];

      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const obj = item as Record<string, unknown>;
        processJsonLDNode(obj, entities);
      }
    } catch {
      // Malformed JSON-LD — skip
    }
  });

  // Also check microdata
  $("[itemtype*='schema.org/Person']").each((_, el) => {
    const name = $(el).find("[itemprop='name']").first().text().trim();
    const jobTitle = $(el).find("[itemprop='jobTitle']").first().text().trim();
    const email = $(el).find("[itemprop='email']").first().text().trim();
    const url = $(el).find("[itemprop='url']").first().attr("href") ?? "";
    if (name) {
      entities.push({ type: "Person", name, jobTitle, email, url });
    }
  });

  $("[itemtype*='schema.org/Organization'], [itemtype*='schema.org/LocalBusiness']").each((_, el) => {
    const name = $(el).find("[itemprop='name']").first().text().trim();
    const desc = $(el).find("[itemprop='description']").first().text().trim();
    const tel = $(el).find("[itemprop='telephone']").first().text().trim();
    const email = $(el).find("[itemprop='email']").first().text().trim();
    const empCount = $(el).find("[itemprop='numberOfEmployees']").first().text().trim();
    if (name) {
      entities.push({
        type: "Organization",
        name,
        description: desc || undefined,
        telephone: tel || undefined,
        email: email || undefined,
        numberOfEmployees: empCount || undefined,
      });
    }
  });

  return entities;
}

function processJsonLDNode(obj: Record<string, unknown>, entities: StructuredEntity[]) {
  const type = String(obj["@type"] ?? "");

  if (type === "Person" || type === "OrganizationRole") {
    entities.push({
      type: "Person",
      name: strVal(obj.name),
      jobTitle: strVal(obj.jobTitle),
      url: strVal(obj.url),
      email: strVal(obj.email),
      telephone: strVal(obj.telephone),
      sameAs: arrVal(obj.sameAs),
    });
  }

  if (type === "Organization" || type === "Corporation" || type === "LocalBusiness") {
    const org: StructuredEntity = {
      type: "Organization",
      name: strVal(obj.name),
      url: strVal(obj.url),
      email: strVal(obj.email),
      telephone: strVal(obj.telephone),
      description: strVal(obj.description),
      foundingDate: strVal(obj.foundingDate),
      numberOfEmployees: extractEmployeeCount(obj.numberOfEmployees),
      address: extractAddress(obj.address),
      sameAs: arrVal(obj.sameAs),
    };

    // Process nested employees/founders
    for (const key of ["employee", "member", "founder", "founders"]) {
      const nested = obj[key];
      const items = Array.isArray(nested) ? nested : nested ? [nested] : [];
      for (const item of items) {
        if (item && typeof item === "object") {
          processJsonLDNode(item as Record<string, unknown>, entities);
        }
      }
    }

    entities.push(org);
  }

  // Handle @graph arrays
  if (Array.isArray(obj["@graph"])) {
    for (const node of obj["@graph"]) {
      if (node && typeof node === "object") {
        processJsonLDNode(node as Record<string, unknown>, entities);
      }
    }
  }
}

function strVal(v: unknown): string | undefined {
  return typeof v === "string" ? v.trim() || undefined : undefined;
}

function arrVal(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.filter((s): s is string => typeof s === "string");
  if (typeof v === "string") return [v];
  return undefined;
}

function extractEmployeeCount(v: unknown): string | undefined {
  if (!v) return undefined;
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    // QuantitativeValue schema
    if (obj.value) return String(obj.value);
    if (obj.minValue && obj.maxValue) return `${obj.minValue}-${obj.maxValue}`;
  }
  return undefined;
}

function extractAddress(v: unknown): string | undefined {
  if (!v) return undefined;
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const parts = [
      obj.streetAddress,
      obj.addressLocality,
      obj.addressRegion,
      obj.postalCode,
      obj.addressCountry,
    ].filter(Boolean).map(String);
    return parts.length > 0 ? parts.join(", ") : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// CSS Selector Heuristics
// ---------------------------------------------------------------------------

interface CSSPerson {
  name: string;
  title: string;
  linkedinUrl?: string;
}

function extractPeopleFromCSS(html: string): CSSPerson[] {
  const results: CSSPerson[] = [];
  const $ = cheerio.load(html);

  // CSS selectors sourced from agent profile
  const cssProfile = getProfile().cssSelectors;
  const CARD_SELECTORS = cssProfile.card;
  const NAME_SELECTORS = cssProfile.name;
  const TITLE_SELECTORS = cssProfile.title;

  let cardHits = 0;
  for (const selector of CARD_SELECTORS) {
    $(selector).each((_, card) => {
      let name = "";
      let title = "";
      let linkedinUrl: string | undefined;

      for (const ns of NAME_SELECTORS) {
        const text = $(card).find(ns).first().text().trim();
        if (text && text.length > 1 && text.length < 80 && /^[A-Z]/.test(text)) {
          name = text;
          break;
        }
      }

      for (const ts of TITLE_SELECTORS) {
        const text = $(card).find(ts).first().text().trim();
        if (text && text.length > 1 && text.length < 120) {
          title = text;
          break;
        }
      }

      // Extract LinkedIn URL from the card
      const linkedIn = $(card).find('a[href*="linkedin.com/in/"]').first().attr("href");
      if (linkedIn) linkedinUrl = linkedIn;

      if (name) {
        results.push({ name, title, linkedinUrl });
        cardHits++;
      }
    });
    if (cardHits > 0) break;
  }

  // Fallback: heading-pair heuristic
  if (cardHits === 0) {
    const TITLE_KEYWORDS = /\b(ceo|cto|cfo|coo|cmo|cpo|ciso|founder|partner|president|director|head|manager|lead|vp|vice president|officer|principal)\b/i;
    $("h3, h4").each((_, heading) => {
      const nameText = $(heading).text().trim();
      if (!nameText || nameText.length < 3 || nameText.length > 60) return;
      if (!/^[A-Z][a-z]/.test(nameText)) return;

      const sibling = $(heading).next("p, .title, .role, .position, span").first();
      const titleText = sibling.text().trim();

      if (titleText && TITLE_KEYWORDS.test(titleText)) {
        results.push({ name: nameText, title: titleText });
      }
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Deterministic Regex Extraction (LinkedIn URLs, emails, phones)
// ---------------------------------------------------------------------------

interface DeterministicSignals {
  linkedinUrls: string[];
  emails: string[];
  phones: string[];
  metaDescription: string;
  foundedYear: string;
  addressEl: string;
  companyLinkedin: string[];
}

function extractDeterministicSignals(html: string): DeterministicSignals {
  const $ = cheerio.load(html);

  // LinkedIn profile URLs
  const linkedinUrls: string[] = [];
  $('a[href*="linkedin.com/in/"]').each((_, el) => {
    const href = $(el).attr("href");
    if (href) {
      const cleaned = href.split("?")[0]; // Remove tracking params
      if (!linkedinUrls.includes(cleaned)) linkedinUrls.push(cleaned);
    }
  });

  // Email addresses from mailto: links
  const emails: string[] = [];
  $('a[href^="mailto:"]').each((_, el) => {
    const href = $(el).attr("href");
    if (href) {
      const email = href.replace("mailto:", "").split("?")[0].trim();
      if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !emails.includes(email)) {
        emails.push(email);
      }
    }
  });

  // Phone numbers from tel: links
  const phones: string[] = [];
  $('a[href^="tel:"]').each((_, el) => {
    const href = $(el).attr("href");
    if (href) {
      const phone = href.replace("tel:", "").trim();
      if (phone && !phones.includes(phone)) phones.push(phone);
    }
  });

  // Meta description
  const metaDescription = $('meta[name="description"]').attr("content")?.trim() ?? "";

  // Founded year from page text
  const bodyText = $("body").text();
  const foundedMatch = bodyText.match(/(?:founded|established|since)\s*(?:in\s*)?(\d{4})/i);
  const foundedYear = foundedMatch?.[1] ?? "";

  // Address from <address> element
  const addressEl = $("address").first().text().trim();

  // Company LinkedIn URL
  const companyLinkedin: string[] = [];
  $('a[href*="linkedin.com/company/"]').each((_, el) => {
    const href = $(el).attr("href");
    if (href) {
      const cleaned = href.split("?")[0];
      if (!companyLinkedin.includes(cleaned)) companyLinkedin.push(cleaned);
    }
  });

  return { linkedinUrls, emails, phones, metaDescription, foundedYear, addressEl, companyLinkedin };
}

// ---------------------------------------------------------------------------
// Main: Pre-LLM field extraction
// ---------------------------------------------------------------------------

/**
 * Run all pre-LLM extraction passes against the raw HTML.
 * Returns a FieldResultMap with deterministic, high-confidence extractions.
 * Fields NOT matched by pre-LLM passes are left empty (confidence 0.0)
 * so the LLM pass can fill them in.
 */
export function preLLMExtract(
  html: string,
  sections: AgentSection[],
  sourceUrl?: string,
): FieldResultMap {
  const results: FieldResultMap = {};
  for (const s of sections) {
    results[s.key] = { value: "", confidence: 0.0, sourceUrl };
  }

  // Pass 1: JSON-LD / microdata
  const entities = extractJsonLD(html);
  const orgEntities = entities.filter(e => e.type === "Organization");
  const personEntities = entities.filter(e => e.type === "Person");

  // Pass 2: CSS heuristics
  const cssPeople = extractPeopleFromCSS(html);

  // Pass 3: Deterministic signals
  const signals = extractDeterministicSignals(html);

  // Combine all people (JSON-LD + CSS, deduplicated)
  const allPeople: Array<{ name: string; title: string; linkedinUrl?: string; confidence: number }> = [];

  for (const p of personEntities) {
    if (p.name) {
      allPeople.push({
        name: p.name,
        title: p.jobTitle ?? "",
        linkedinUrl: p.sameAs?.find(u => u.includes("linkedin.com/in/")),
        confidence: CONFIDENCE.JSON_LD,
      });
    }
  }

  for (const p of cssPeople) {
    const exists = allPeople.some(e => e.name.toLowerCase() === p.name.toLowerCase());
    if (!exists) {
      allPeople.push({
        name: p.name,
        title: p.title,
        linkedinUrl: p.linkedinUrl,
        confidence: CONFIDENCE.CSS_CARD,
      });
    }
  }

  // Rank people by decision-maker tier
  const rankedPeople = rankByDecisionMakerTier(allPeople);

  // Map extracted data to sections
  for (const s of sections) {
    const keyLower = s.key.toLowerCase();
    const labelLower = s.label.toLowerCase();
    const combined = keyLower + " " + labelLower;

    // -- Organization fields from JSON-LD --
    const org = orgEntities[0];
    if (org) {
      if (/description|tagline|about|overview|summary/i.test(combined) && org.description) {
        results[s.key] = { value: org.description, confidence: CONFIDENCE.JSON_LD, sourceUrl };
        continue;
      }
      if (/founded|year.?founded|established/i.test(combined) && org.foundingDate) {
        const year = org.foundingDate.match(/\d{4}/)?.[0];
        if (year) {
          results[s.key] = { value: year, confidence: CONFIDENCE.JSON_LD, sourceUrl };
          continue;
        }
      }
      if (/employee|company.?size|headcount/i.test(combined) && org.numberOfEmployees) {
        results[s.key] = { value: org.numberOfEmployees, confidence: CONFIDENCE.JSON_LD, sourceUrl };
        continue;
      }
      if (/headquarter|hq|location|address/i.test(combined) && org.address) {
        results[s.key] = { value: org.address, confidence: CONFIDENCE.JSON_LD, sourceUrl };
        continue;
      }
      if (/phone|tel/i.test(combined) && org.telephone) {
        results[s.key] = { value: org.telephone, confidence: CONFIDENCE.JSON_LD, sourceUrl };
        continue;
      }
      if (/email/i.test(combined) && org.email) {
        results[s.key] = { value: org.email, confidence: CONFIDENCE.JSON_LD, sourceUrl };
        continue;
      }
    }

    // -- People fields --
    const dmMatch = combined.match(/(?:decision.?maker|dm|contact|key.?person)\s*(\d)?/i);
    const dmIndex = dmMatch ? (parseInt(dmMatch[1] || "1", 10) - 1) : -1;

    if (dmIndex >= 0 && /name/i.test(combined)) {
      const person = rankedPeople[dmIndex];
      if (person) {
        results[s.key] = { value: person.name, confidence: person.confidence, sourceUrl };
        continue;
      }
    }
    if (dmIndex >= 0 && /title|role|position/i.test(combined)) {
      const person = rankedPeople[dmIndex];
      if (person?.title) {
        results[s.key] = { value: person.title, confidence: person.confidence, sourceUrl };
        continue;
      }
    }
    if (dmIndex >= 0 && /linkedin/i.test(combined)) {
      const person = rankedPeople[dmIndex];
      if (person?.linkedinUrl) {
        results[s.key] = { value: person.linkedinUrl, confidence: CONFIDENCE.REGEX_DETERMINISTIC, sourceUrl };
        continue;
      }
    }

    // Fallback: generic CEO/founder/owner name fields
    if (/\b(ceo|founder|owner)\b/i.test(combined) && /name/i.test(combined)) {
      const ceo = rankedPeople[0];
      if (ceo) {
        results[s.key] = { value: ceo.name, confidence: ceo.confidence, sourceUrl };
        continue;
      }
    }
    if (/\b(ceo|founder|owner)\b/i.test(combined) && /title/i.test(combined)) {
      const ceo = rankedPeople[0];
      if (ceo?.title) {
        results[s.key] = { value: ceo.title, confidence: ceo.confidence, sourceUrl };
        continue;
      }
    }

    // -- Deterministic signals --
    if (/email/i.test(combined) && !results[s.key]?.value && signals.emails.length > 0) {
      results[s.key] = { value: signals.emails[0], confidence: CONFIDENCE.REGEX_DETERMINISTIC, sourceUrl };
      continue;
    }
    if (/phone|tel/i.test(combined) && !results[s.key]?.value && signals.phones.length > 0) {
      results[s.key] = { value: signals.phones[0], confidence: CONFIDENCE.REGEX_DETERMINISTIC, sourceUrl };
      continue;
    }
    if (/linkedin/i.test(combined) && !results[s.key]?.value && signals.linkedinUrls.length > 0) {
      // Only use for company LinkedIn, not people LinkedIn (those are handled above)
      if (/company|org/i.test(combined)) {
        results[s.key] = { value: signals.linkedinUrls[0], confidence: CONFIDENCE.REGEX_DETERMINISTIC, sourceUrl };
        continue;
      }
    }

    // -- Enhanced deterministic signals (new: meta desc, founded year, address, domain) --
    if (/description|tagline|about|overview|summary/i.test(combined) && !results[s.key]?.value && signals.metaDescription) {
      results[s.key] = { value: signals.metaDescription, confidence: CONFIDENCE.CSS_HEADING_PAIR, sourceUrl };
      continue;
    }
    if (/founded|year.?founded|established/i.test(combined) && !results[s.key]?.value && signals.foundedYear) {
      results[s.key] = { value: signals.foundedYear, confidence: CONFIDENCE.REGEX_DETERMINISTIC, sourceUrl };
      continue;
    }
    if (/headquarter|hq|location|address/i.test(combined) && !results[s.key]?.value && signals.addressEl) {
      results[s.key] = { value: signals.addressEl, confidence: CONFIDENCE.CSS_HEADING_PAIR, sourceUrl };
      continue;
    }
    if (/domain|website|web.?url|homepage/i.test(combined) && !results[s.key]?.value && sourceUrl) {
      // Domain is trivially extractable from the URL itself
      try {
        const domain = new URL(sourceUrl).hostname.replace(/^www\./, "");
        results[s.key] = { value: domain, confidence: CONFIDENCE.REGEX_DETERMINISTIC, sourceUrl };
        continue;
      } catch { /* ignore */ }
    }
    if (/linkedin/i.test(combined) && /company|org/i.test(combined) && !results[s.key]?.value && signals.companyLinkedin.length > 0) {
      results[s.key] = { value: signals.companyLinkedin[0], confidence: CONFIDENCE.REGEX_DETERMINISTIC, sourceUrl };
    }
  }

  const filled = Object.values(results).filter(r => r.value && r.confidence > 0).length;
  if (filled > 0) {
    console.log(`[preLLMExtract] Deterministically extracted ${filled}/${sections.length} fields from ${sourceUrl ?? "unknown"}`);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Decision-maker tier ranking (deterministic)
// ---------------------------------------------------------------------------

const TIER_PATTERNS: Array<{ tier: number; pattern: RegExp }> = [
  { tier: 1, pattern: /\b(ceo|founder|co-?founder|owner|president|managing\s+director|managing\s+partner|principal|executive\s+director|chief\s+executive)\b/i },
  { tier: 2, pattern: /\b(cto|chief\s+technology|vp\s+engineering|vp\s+technology|vp\s+digital|director\s+of\s+technology|head\s+of\s+technology|technical\s+director|vp\s+product|head\s+of\s+product)\b/i },
  { tier: 3, pattern: /\b(coo|cfo|cmo|cpo|vp\s+operations|director\s+of\s+operations|general\s+manager|vp\s+client|director\s+of\s+client|account\s+director|vp\s+strategy|director\s+of\s+strategy)\b/i },
  { tier: 4, pattern: /\b(creative\s+director|art\s+director|design\s+director|marketing\s+director|brand\s+director|content\s+director|head\s+of\s+creative)\b/i },
  { tier: 5, pattern: /\b(designer|developer|project\s+manager|account\s+manager|coordinator|analyst|associate)\b/i },
];

function rankByDecisionMakerTier<T extends { title: string }>(people: T[]): T[] {
  return [...people].sort((a, b) => {
    const tierA = getTier(a.title);
    const tierB = getTier(b.title);
    return tierA - tierB;
  });
}

function getTier(title: string): number {
  for (const { tier, pattern } of TIER_PATTERNS) {
    if (pattern.test(title)) return tier;
  }
  return 6; // unranked
}

// ---------------------------------------------------------------------------
// Export structured entity types for use by map phase
// ---------------------------------------------------------------------------

export { extractJsonLD, extractDeterministicSignals, extractPeopleFromCSS };
export type { StructuredEntity, CSSPerson, DeterministicSignals };
