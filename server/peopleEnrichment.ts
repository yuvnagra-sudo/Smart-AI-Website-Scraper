/**
 * peopleEnrichment.ts — Shared people-discovery pipeline
 *
 * Used by both the VC enrichment path and the custom agent job path.
 * All functions mutate the input array in-place for efficiency.
 *
 * Pipeline order (called via enrichPeopleInPlace):
 *   1. classifyTiersInPlace  — sync regex classifier, zero cost
 *   2. mergeApolloContacts   — free people discovery (name/title/LinkedIn, no email credits)
 */

import { classifyDecisionMakerTier } from "./decisionMakerTiers";
import { findPersonByName } from "./nameNormalization";
import { apifySearchLinkedInEmployees } from "./dataSources/apifyLinkedin";

/** Company-level data — kept for compatibility with routers.ts; Apify does not populate this. */
export interface ApolloOrganization {
  employeeCount: number | null;
  employeeRange: string | null;
  industry: string | null;
  foundedYear: number | null;
  city: string | null;
  country: string | null;
  shortDescription: string | null;
}

// Minimal shape required by the people enrichment pipeline.
// Both TeamMember (vcEnrichment.ts) and custom agent contact shapes satisfy this.
export interface EnrichableContact {
  name: string;
  title: string;
  email?: string;
  decisionMakerTier?: string;
  linkedinUrl?: string;
}

// ---------------------------------------------------------------------------
// Step 1 — Tier classification
// ---------------------------------------------------------------------------

/**
 * Classifies decision-maker tiers for every member in-place.
 * Skips contacts that already have a tier set.
 */
export function classifyTiersInPlace(
  members: Array<{ title: string; decisionMakerTier?: string }>,
): void {
  for (const m of members) {
    if (!m.decisionMakerTier && m.title) {
      const result = classifyDecisionMakerTier(m.title);
      if (result.tier !== "Exclude") {
        m.decisionMakerTier = result.tier;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Step 2 — Apollo people discovery
// ---------------------------------------------------------------------------

/**
 * Searches LinkedIn (via Apify) for people at `domain` and merges results into `members`:
 * - If the person already exists: backfills linkedinUrl if missing
 * - If the person is new (non-Exclude tier): appends them
 *
 * No-ops silently when APIFY_API_KEY is absent.
 * Returns null for organization (Apify does not provide org-level data).
 */
export async function mergeApolloContacts(
  members: EnrichableContact[],
  domain: string,
  onProgress?: (msg: string) => void,
  _apolloSeniorities?: string[],
  companyName?: string,
): Promise<ApolloOrganization | null> {
  const cleanDomain = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  if (!cleanDomain) return null;

  const { people: linkedInPeople } = await apifySearchLinkedInEmployees(cleanDomain, companyName ?? cleanDomain, 25);
  if (linkedInPeople.length === 0) return null;

  console.log(`[peopleEnrichment] LinkedIn returned ${linkedInPeople.length} people for ${cleanDomain}`);
  let added = 0;

  for (const person of linkedInPeople) {
    const tier = classifyDecisionMakerTier(person.title);
    if (tier.tier === "Exclude") continue;

    const existing = findPersonByName(members, person.name) as EnrichableContact | undefined;
    if (existing) {
      if (!existing.linkedinUrl && person.linkedinUrl) {
        existing.linkedinUrl = person.linkedinUrl;
      }
      continue;
    }

    members.push({
      name: person.name,
      title: person.title,
      linkedinUrl: person.linkedinUrl,
      decisionMakerTier: tier.tier,
    });
    added++;
  }

  if (added > 0) {
    onProgress?.(`LinkedIn added ${added} new contacts`);
    console.log(`[peopleEnrichment] LinkedIn added ${added} new contacts`);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * People-discovery pipeline. Mutates `members` in-place.
 *
 * Steps:
 *   1. Classify decision-maker tiers (free, sync)
 *   2. Merge Apollo contacts (free — fills gaps + appends new people via domain search)
 */
export async function enrichPeopleInPlace(
  members: EnrichableContact[],
  websiteUrl: string,
  options: {
    companyName?: string;
    onProgress?: (msg: string) => void;
    apolloSeniorities?: string[];
  } = {},
): Promise<void> {
  const { companyName, onProgress, apolloSeniorities } = options;

  // Step 1: Tier classification
  classifyTiersInPlace(members);

  // Step 2: LinkedIn via Apify — always run when key is set
  let domain = "";
  try { domain = new URL(websiteUrl).hostname; } catch { domain = websiteUrl; }

  await mergeApolloContacts(members, domain, onProgress, apolloSeniorities, companyName);
}
