/**
 * Niche / Category Taxonomy (Generic)
 *
 * Stripped of hardcoded VC investment niches.
 * The LLM now derives categories from the actual website content
 * rather than being constrained to a predefined taxonomy.
 */

export function formatNichesForPrompt(): string {
  return `Identify the specific focus areas, specializations, or categories based on what you find in the content. Do not limit yourself to any predefined list — extract what is actually stated or clearly implied on the website.`;
}
