/**
 * Agent Profile Configuration Loader
 *
 * Loads .md profile files from server/profiles/ and parses them into typed
 * config objects. Each profile has JSON frontmatter (tactical parameters)
 * and markdown body (strategic intelligence / prompt text).
 *
 * Profiles support inheritance via "extends": child profiles merge with
 * their parent, overriding or extending specific sections.
 *
 * No external dependencies — uses JSON.parse for frontmatter.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentProfile {
  // Identity
  name: string;
  extends?: string;

  // Model selection (per-call model override)
  extractionModel: string;
  planningModel: string;

  // Tactical parameters (from JSON frontmatter)
  confidenceThreshold: number;
  maxHops: number;
  confidenceLevels: Record<string, number>;
  methodRank: Record<string, number>;
  confidenceOverrides: Record<string, number>;
  cssSelectors: { card: string[]; name: string[]; title: string[] };
  peopleFieldPattern: string;
  techFieldPattern: string;
  domainFieldPattern: string;
  noiseDomains: string[];
  skipDomains: string[];
  urlCategories: Record<string, { priority: number; patterns: string[] }>;
  teamPageCandidates: string[];
  tierPatterns: {
    tier1: string[];
    tier2: string[];
    tier3: string[];
    exclude: string[];
    pre_tier_exclusions: string[];
  };

  // Strategic intelligence (from markdown body, keyed by heading)
  sections: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Profile cache
// ---------------------------------------------------------------------------

const profileCache = new Map<string, AgentProfile>();
const __filename_esm = fileURLToPath(import.meta.url);
const __dirname_esm = path.dirname(__filename_esm);
const PROFILES_DIR = path.join(__dirname_esm, "profiles");

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a profile .md file into frontmatter (JSON) + body sections (markdown).
 */
function parseProfileFile(content: string): { frontmatter: Record<string, unknown>; sections: Record<string, string> } {
  // Split on ---json / --- delimiters
  const fmStart = content.indexOf("---json");
  const fmEnd = content.indexOf("---", fmStart + 7);

  let frontmatter: Record<string, unknown> = {};
  let body = content;

  if (fmStart !== -1 && fmEnd !== -1) {
    const jsonStr = content.substring(fmStart + 7, fmEnd).trim();
    try {
      frontmatter = JSON.parse(jsonStr);
    } catch (err) {
      console.error(`[agentConfig] Failed to parse JSON frontmatter:`, err instanceof Error ? err.message : String(err));
    }
    body = content.substring(fmEnd + 3).trim();
  }

  // Parse markdown body by # headings into sections
  const sections: Record<string, string> = {};
  const headingRegex = /^# (.+)$/gm;
  const headings: Array<{ title: string; index: number }> = [];

  let match: RegExpExecArray | null;
  while ((match = headingRegex.exec(body)) !== null) {
    headings.push({ title: match[1].trim(), index: match.index + match[0].length });
  }

  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].index;
    const end = i + 1 < headings.length ? headings[i + 1].index - headings[i + 1].title.length - 3 : body.length;
    const sectionContent = body.substring(start, end).trim();
    sections[headings[i].title] = sectionContent;
  }

  return { frontmatter, sections };
}

/**
 * Convert raw frontmatter into a typed partial AgentProfile.
 */
function frontmatterToProfile(fm: Record<string, unknown>): Partial<AgentProfile> {
  const p: Partial<AgentProfile> = {};

  if (typeof fm.name === "string") p.name = fm.name;
  if (typeof fm.extends === "string") p.extends = fm.extends;
  if (typeof fm.extraction_model === "string") p.extractionModel = fm.extraction_model;
  if (typeof fm.planning_model === "string") p.planningModel = fm.planning_model;
  if (typeof fm.confidence_threshold === "number") p.confidenceThreshold = fm.confidence_threshold;
  if (typeof fm.max_hops === "number") p.maxHops = fm.max_hops;
  if (fm.confidence_levels && typeof fm.confidence_levels === "object") p.confidenceLevels = fm.confidence_levels as Record<string, number>;
  if (fm.method_rank && typeof fm.method_rank === "object") p.methodRank = fm.method_rank as Record<string, number>;
  if (fm.confidence_overrides && typeof fm.confidence_overrides === "object") p.confidenceOverrides = fm.confidence_overrides as Record<string, number>;
  if (fm.css_selectors && typeof fm.css_selectors === "object") p.cssSelectors = fm.css_selectors as AgentProfile["cssSelectors"];
  if (typeof fm.people_field_pattern === "string") p.peopleFieldPattern = fm.people_field_pattern;
  if (typeof fm.tech_field_pattern === "string") p.techFieldPattern = fm.tech_field_pattern;
  if (typeof fm.domain_field_pattern === "string") p.domainFieldPattern = fm.domain_field_pattern;
  if (Array.isArray(fm.noise_domains)) p.noiseDomains = fm.noise_domains as string[];
  if (Array.isArray(fm.skip_domains)) p.skipDomains = fm.skip_domains as string[];
  if (fm.url_categories && typeof fm.url_categories === "object") p.urlCategories = fm.url_categories as AgentProfile["urlCategories"];
  if (Array.isArray(fm.team_page_candidates)) p.teamPageCandidates = fm.team_page_candidates as string[];
  if (fm.tier_patterns && typeof fm.tier_patterns === "object") p.tierPatterns = fm.tier_patterns as AgentProfile["tierPatterns"];

  return p;
}

// ---------------------------------------------------------------------------
// Merge logic
// ---------------------------------------------------------------------------

/**
 * Deep merge a child profile onto a parent.
 * - Arrays: child concatenated after parent
 * - Objects: shallow merge (child keys override parent)
 * - Strings/numbers: child replaces parent
 * - Sections: child replaces parent per-key (doesn't merge within a section)
 */
function mergeProfiles(parent: AgentProfile, child: Partial<AgentProfile>, childSections: Record<string, string>): AgentProfile {
  const merged: AgentProfile = { ...parent };

  // Merge frontmatter fields
  for (const [key, value] of Object.entries(child)) {
    if (key === "extends" || key === "sections" || value === undefined) continue;

    const k = key as keyof AgentProfile;
    const parentVal = (parent as any)[k];

    if (Array.isArray(value) && Array.isArray(parentVal)) {
      // Arrays concatenate
      (merged as any)[k] = [...parentVal, ...value];
    } else if (value && typeof value === "object" && !Array.isArray(value) && parentVal && typeof parentVal === "object" && !Array.isArray(parentVal)) {
      // Objects shallow merge
      (merged as any)[k] = { ...parentVal, ...value };
    } else {
      // Primitives replace
      (merged as any)[k] = value;
    }
  }

  // Merge sections: child sections override parent per-key
  merged.sections = { ...parent.sections };
  for (const [key, value] of Object.entries(childSections)) {
    if (value.trim()) {
      merged.sections[key] = value;
    }
  }

  // Override name with child's name
  if (child.name) merged.name = child.name;

  return merged;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Load a single profile by name (without resolving extends).
 */
function loadRawProfile(name: string): { partial: Partial<AgentProfile>; sections: Record<string, string> } {
  const filePath = path.join(PROFILES_DIR, `${name}.md`);

  if (!fs.existsSync(filePath)) {
    console.error(`[agentConfig] Profile not found: ${filePath}`);
    throw new Error(`Agent profile "${name}" not found at ${filePath}`);
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const { frontmatter, sections } = parseProfileFile(content);
  const partial = frontmatterToProfile(frontmatter);

  return { partial, sections };
}

/**
 * Load and resolve a profile, following the extends chain.
 * Caches resolved profiles for the lifetime of the process.
 */
function resolveProfile(name: string, visited = new Set<string>()): AgentProfile {
  // Check cache
  const cached = profileCache.get(name);
  if (cached) return cached;

  // Circular dependency check
  if (visited.has(name)) {
    throw new Error(`Circular profile extends chain detected: ${[...visited, name].join(" -> ")}`);
  }
  visited.add(name);

  const { partial, sections } = loadRawProfile(name);

  let profile: AgentProfile;

  if (partial.extends) {
    // Resolve parent first, then merge
    const parent = resolveProfile(partial.extends, visited);
    profile = mergeProfiles(parent, partial, sections);
  } else {
    // Base profile — fill defaults for any missing fields
    profile = {
      name: partial.name ?? name,
      extractionModel: partial.extractionModel ?? "gpt-5-nano",
      planningModel: partial.planningModel ?? "gpt-5-nano",
      confidenceThreshold: partial.confidenceThreshold ?? 0.7,
      maxHops: partial.maxHops ?? 7,
      confidenceLevels: partial.confidenceLevels ?? {},
      methodRank: partial.methodRank ?? {},
      confidenceOverrides: partial.confidenceOverrides ?? {},
      cssSelectors: partial.cssSelectors ?? { card: [], name: [], title: [] },
      peopleFieldPattern: partial.peopleFieldPattern ?? "",
      techFieldPattern: partial.techFieldPattern ?? "",
      domainFieldPattern: partial.domainFieldPattern ?? "",
      noiseDomains: partial.noiseDomains ?? [],
      skipDomains: partial.skipDomains ?? [],
      urlCategories: partial.urlCategories ?? {},
      teamPageCandidates: partial.teamPageCandidates ?? [],
      tierPatterns: partial.tierPatterns ?? { tier1: [], tier2: [], tier3: [], exclude: [], pre_tier_exclusions: [] },
      sections,
    };
  }

  // Validate required sections
  const requiredSections = ["Agent Persona", "Planner Decision Rules", "Critical Extraction Rules"];
  for (const req of requiredSections) {
    if (!profile.sections[req]) {
      console.warn(`[agentConfig] WARNING: Profile "${name}" is missing required section: "${req}"`);
    }
  }

  // Cache and return
  profileCache.set(name, profile);

  const sectionCount = Object.keys(profile.sections).length;
  const configKeys = Object.keys(profile.tierPatterns.tier1).length;
  console.log(`[agentConfig] Loaded profile "${name}" (${sectionCount} sections, extends: ${partial.extends ?? "none"})`);

  return profile;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get a resolved agent profile by name.
 * Defaults to "base" if no name is provided.
 * Profiles are cached after first load.
 */
export function getProfile(name?: string | null): AgentProfile {
  return resolveProfile(name || "base");
}

/**
 * Clear the profile cache (useful for hot-reload in development).
 */
export function clearProfileCache(): void {
  profileCache.clear();
  console.log("[agentConfig] Profile cache cleared");
}

/**
 * List available profile names by scanning the profiles directory.
 */
export function listProfiles(): string[] {
  try {
    return fs.readdirSync(PROFILES_DIR)
      .filter(f => f.endsWith(".md"))
      .map(f => f.replace(".md", ""));
  } catch {
    return [];
  }
}

/**
 * Helper to get a specific section from a profile, with fallback to empty string.
 */
export function getSection(profile: AgentProfile, sectionName: string): string {
  return profile.sections[sectionName] ?? "";
}

/**
 * Helper to get a sub-section (## heading) from within a section.
 * Used for page-type-specific guidance within "Page Type Confidence Guidance".
 */
export function getSubSection(profile: AgentProfile, sectionName: string, subSectionName: string): string {
  const section = profile.sections[sectionName];
  if (!section) return "";

  // Find ## SubSection within the section
  const subRegex = new RegExp(`^## ${subSectionName}\\s*$`, "mi");
  const match = subRegex.exec(section);
  if (!match) return "";

  const start = match.index + match[0].length;
  // Find next ## or end of section
  const nextSub = section.indexOf("\n## ", start);
  const end = nextSub !== -1 ? nextSub : section.length;

  return section.substring(start, end).trim();
}
