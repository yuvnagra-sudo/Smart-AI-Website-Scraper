/**
 * Name Normalization Utilities
 * Robust name comparison and deduplication
 */

/**
 * Normalize a person's name for comparison
 * Handles: extra whitespace, special characters, accents, case
 */
export function normalizeName(name: string): string {
  if (!name) return "";
  
  return name
    .toLowerCase()
    .trim()
    // Remove accents: é → e, ñ → n, etc.
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    // Replace multiple spaces with single space
    .replace(/\s+/g, " ")
    // Remove special characters except hyphens and apostrophes
    .replace(/[^a-z0-9\s\-']/g, "")
    // Trim again after replacements
    .trim();
}

/**
 * Check if two names are the same person
 * Uses normalized comparison
 */
export function isSamePerson(name1: string, name2: string): boolean {
  const normalized1 = normalizeName(name1);
  const normalized2 = normalizeName(name2);
  
  if (normalized1 === normalized2) {
    return true;
  }
  
  // Additional check: handle "John Smith" vs "Smith, John"
  const parts1 = normalized1.split(" ");
  const parts2 = normalized2.split(" ");
  
  if (parts1.length === 2 && parts2.length === 2) {
    // Check if reversed: "John Smith" === "Smith John"
    if (parts1[0] === parts2[1] && parts1[1] === parts2[0]) {
      return true;
    }
  }
  
  return false;
}

/**
 * Find a person in an array by name
 * Uses robust name comparison
 */
export function findPersonByName<T extends { name: string }>(
  array: T[],
  name: string
): T | undefined {
  return array.find(item => isSamePerson(item.name, name));
}
