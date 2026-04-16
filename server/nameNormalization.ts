/**
 * Name Normalization Utilities
 * Robust name comparison and deduplication
 *
 * Handles: accents, hyphens, suffixes (Jr/Sr/III), nicknames (Bob/Robert),
 * name reversal (Smith John = John Smith), and subset matching
 * (John Smith matches John Michael Smith).
 */

// ---------------------------------------------------------------------------
// Nickname database (imported concept from smartUrlConstructor.ts)
// ---------------------------------------------------------------------------

const NICKNAME_MAP: Record<string, string[]> = {
  // Male names
  robert: ["bob", "rob", "bobby"],
  william: ["bill", "will", "billy", "willy"],
  richard: ["rick", "dick", "rich"],
  james: ["jim", "jimmy", "jamie"],
  michael: ["mike", "mikey"],
  christopher: ["chris"],
  matthew: ["matt"],
  daniel: ["dan", "danny"],
  joseph: ["joe", "joey"],
  anthony: ["tony"],
  thomas: ["tom", "tommy"],
  charles: ["chuck", "charlie"],
  david: ["dave", "davey"],
  andrew: ["andy", "drew"],
  benjamin: ["ben", "benny"],
  alexander: ["alex"],
  jonathan: ["jon", "johnny"],
  nicholas: ["nick", "nicky"],
  samuel: ["sam", "sammy"],
  timothy: ["tim", "timmy"],
  edward: ["ed", "eddie", "ted"],
  stephen: ["steve", "steven"],
  gregory: ["greg"],
  lawrence: ["larry"],
  raymond: ["ray"],
  kenneth: ["ken", "kenny"],
  phillip: ["phil"],
  // Female names
  elizabeth: ["liz", "beth", "betty", "lizzie"],
  katherine: ["kate", "katie", "kathy", "kat"],
  catherine: ["kate", "katie", "cathy", "cat"],
  margaret: ["maggie", "meg", "peggy"],
  jennifer: ["jen", "jenny"],
  jessica: ["jess", "jessie"],
  patricia: ["pat", "patty", "tricia"],
  rebecca: ["becky", "becca"],
  deborah: ["deb", "debbie"],
  susan: ["sue", "susie"],
  christine: ["chris", "christina", "tina"],
  kimberly: ["kim", "kimmy"],
  michelle: ["mich", "shelly"],
  amanda: ["mandy"],
  stephanie: ["steph"],
  victoria: ["vicky", "tori"],
  alexandra: ["alex", "alexa"],
  samantha: ["sam"],
};

// Build reverse map: bob → robert, etc.
const REVERSE_NICKNAME_MAP: Record<string, string> = {};
for (const [formal, nicks] of Object.entries(NICKNAME_MAP)) {
  for (const nick of nicks) {
    REVERSE_NICKNAME_MAP[nick] = formal;
  }
}

// Suffixes to strip before comparison
const SUFFIXES = /\b(jr|sr|ii|iii|iv|v|phd|md|esq|cpa|cfa|mba|dds|do|jd)\b\.?/gi;

// ---------------------------------------------------------------------------
// Core normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a person's name for comparison.
 * Strips accents, hyphens→spaces, suffixes, and special characters.
 */
export function normalizeName(name: string): string {
  if (!name) return "";

  return name
    .toLowerCase()
    .trim()
    // Remove accents: é → e, ñ → n, etc.
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    // Replace hyphens with spaces (Mary-Jane → Mary Jane)
    .replace(/-/g, " ")
    // Strip suffixes (Jr., Sr., III, PhD, etc.)
    .replace(SUFFIXES, "")
    // Replace multiple spaces with single space
    .replace(/\s+/g, " ")
    // Remove special characters except apostrophes
    .replace(/[^a-z0-9\s']/g, "")
    // Trim again after replacements
    .trim();
}

/**
 * Get the canonical first name, resolving nicknames.
 * "Bob" → "robert", "Mike" → "michael", "John" → "john" (no change)
 */
function canonicalFirstName(name: string): string {
  const lower = name.toLowerCase();
  return REVERSE_NICKNAME_MAP[lower] || lower;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * Check if two names are the same person.
 *
 * Matches:
 * - Exact (after normalization)
 * - Reversed: "Smith John" = "John Smith"
 * - Subset: "John Smith" = "John Michael Smith"
 * - Nicknames: "Bob Smith" = "Robert Smith"
 * - Suffixes: "John Smith Jr." = "John Smith"
 */
export function isSamePerson(name1: string, name2: string): boolean {
  const normalized1 = normalizeName(name1);
  const normalized2 = normalizeName(name2);

  // Exact match after normalization (covers hyphens, suffixes, accents)
  if (normalized1 === normalized2) return true;
  if (!normalized1 || !normalized2) return false;

  const parts1 = normalized1.split(" ").filter(p => p.length > 0);
  const parts2 = normalized2.split(" ").filter(p => p.length > 0);

  if (parts1.length === 0 || parts2.length === 0) return false;

  // Resolve nicknames on first names
  const canon1 = [...parts1];
  const canon2 = [...parts2];
  canon1[0] = canonicalFirstName(canon1[0]);
  canon2[0] = canonicalFirstName(canon2[0]);

  // Exact match after nickname resolution
  if (canon1.join(" ") === canon2.join(" ")) return true;

  // Reversed name check (any length): all parts of one exist in the other
  const set1 = new Set(canon1);
  const set2 = new Set(canon2);

  // Subset matching: if the shorter name's parts are ALL in the longer name
  const shorter = canon1.length <= canon2.length ? canon1 : canon2;
  const longerSet = canon1.length <= canon2.length ? set2 : set1;

  if (shorter.length >= 2 && shorter.every(part => longerSet.has(part))) {
    return true;
  }

  // Last resort: first + last name match (ignoring middle names)
  // "John Michael Smith" vs "John Smith" — first and last match
  if (parts1.length >= 2 && parts2.length >= 2) {
    const first1 = canon1[0];
    const last1 = canon1[canon1.length - 1];
    const first2 = canon2[0];
    const last2 = canon2[canon2.length - 1];

    if (first1 === first2 && last1 === last2) return true;
    // Reversed: "Smith John" vs "John Smith"
    if (first1 === last2 && last1 === first2) return true;
  }

  return false;
}

/**
 * Find a person in an array by name.
 * Uses robust name comparison (nicknames, hyphens, suffixes, subset).
 */
export function findPersonByName<T extends { name: string }>(
  array: T[],
  name: string,
): T | undefined {
  return array.find(item => isSamePerson(item.name, name));
}
