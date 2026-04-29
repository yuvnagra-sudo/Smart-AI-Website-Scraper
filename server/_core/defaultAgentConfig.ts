/**
 * Default agent configuration used when a job arrives without an explicit
 * sectionsJson. Mirrors the b2b template in client/src/lib/templates.ts so
 * the server can hydrate legacy or API-direct jobs and route them through
 * the agent pipeline (instead of the deprecated VC pipeline).
 */

export interface DefaultAgentSection { key: string; label: string; desc: string; }

export const DEFAULT_AGENT_SECTIONS: DefaultAgentSection[] = [
  { key: "industry_vertical",    label: "Industry / Vertical",     desc: "What industry or vertical does this company operate in?" },
  { key: "business_model",       label: "Business Model",          desc: "How does the company make money? (SaaS, services, marketplace, agency, etc.)" },
  { key: "company_size",         label: "Company Size",            desc: "Employee count, revenue range, or funding stage if mentioned on the website" },
  { key: "products_services",    label: "Products & Services",     desc: "Specific products, services, or solutions the company offers — be concrete" },
  { key: "target_customers",     label: "Target Customers / ICP",  desc: "Who are their ideal customers? List industries, company sizes, or roles they serve" },
  { key: "key_decision_makers",  label: "Key Decision Makers",     desc: "Names and titles of founders, CEO, CTO, VP Sales, or other C-suite / VP contacts" },
  { key: "value_proposition",    label: "Value Proposition",       desc: "What is their core value prop or primary differentiator from competitors?" },
  { key: "notable_clients",      label: "Notable Clients",         desc: "Well-known customers or brands featured in case studies, logos, or testimonials" },
  { key: "hq_location",          label: "HQ Location",             desc: "Headquarters city and country" },
  { key: "founded_year",         label: "Founded Year",            desc: "Year the company was founded" },
];

export const DEFAULT_AGENT_SYSTEM_PROMPT =
  "You are a B2B business intelligence analyst. For each company website, extract the requested fields. Focus on business model, product offering, target market, team leadership, and customer evidence. Be specific and concrete — avoid vague summaries. Return ONLY valid JSON with one key per requested field.";

export const DEFAULT_AGENT_OBJECTIVE =
  "Find organization type, industry, size, key decision makers, and contact info for each company";
