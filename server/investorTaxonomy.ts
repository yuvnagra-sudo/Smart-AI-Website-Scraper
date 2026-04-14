/**
 * Organization Type and Stage Taxonomy (Generic)
 *
 * Stripped of hardcoded investor types and investment stages.
 * The LLM now derives organization types and stages from actual content.
 */

export function formatInvestorTypesForPrompt(): string {
  return `Identify the type of organization based on what you find in the content. Do not limit yourself to any predefined list — extract what is actually stated or clearly implied.`;
}

export function formatInvestmentStagesForPrompt(): string {
  return `Identify any relevant stages, phases, or maturity levels based on what you find in the content. Do not limit yourself to any predefined list.`;
}

export function getAllInvestorTypeKeywords(): string[] {
  return [];
}

export function getAllInvestmentStageKeywords(): string[] {
  return [];
}
