/**
 * Scraping Profiles
 *
 * Defines what to extract from a website and how to describe it to the LLM.
 * Profiles make the scraper work for any industry — not just VC firms.
 *
 * Usage:
 *   import { VC_PROFILE, GENERAL_PROFILE, HEALTHCARE_PROFILE } from './scrapeProfile';
 *   const enricher = new VCEnrichmentService(GENERAL_PROFILE);
 */

export interface ScrapeProfile {
  id: string;
  name: string;

  // ── Labels used in LLM prompts ──────────────────────────────────────────────
  /** What the organization is called, e.g. "VC firm", "company", "hospital" */
  organizationLabel: string;
  /** Plural label for people/staff, e.g. "team members", "doctors", "agents" */
  peopleLabel: string;
  /** Singular label for one person, e.g. "team member", "doctor", "agent" */
  peopleSingular: string;
  /**
   * Plural label for related items discovered on the site.
   * VC: "portfolio companies" | General: "products / services" | Healthcare: "locations"
   */
  relatedItemsLabel: string;
  /** Singular of relatedItemsLabel */
  relatedItemsSingular: string;
  /** Label for the main categorization axis, e.g. "investment niches", "specialties", "service categories" */
  categoriesLabel: string;
  /** Label for org classification, e.g. "investor type", "business type", "organization type" */
  typesLabel: string;
  /**
   * Label for a stage/phase concept (null = skip stage extraction entirely).
   * VC: "investment stages" | SaaS: "customer segments" | null for most non-finance domains
   */
  stagesLabel: string | null;

  // ── Taxonomy (null = free-form LLM extraction) ───────────────────────────────
  /**
   * Predefined list of categories to classify against.
   * When null the LLM invents its own categories for the domain.
   */
  categoryTaxonomy: string[] | null;
  /** Predefined org types to identify. null = free-form. */
  organizationTypes: string[] | null;
  /** Predefined stages/phases. null = skip. */
  stages: string[] | null;

  // ── People extraction config ────────────────────────────────────────────────
  /** Job function categories the LLM classifies people into */
  peopleFunctionCategories: string[];
  /**
   * One-line hint for what "specialization" means for this domain.
   * e.g. "Investment focus area (FinTech, Healthcare...)" for VC
   *       "Medical specialty (Cardiology, Oncology...)" for healthcare
   */
  peopleSpecializationHint: string;
  /**
   * Whether to prompt the LLM for investment-mandate-style individual fields
   * (investment_focus, stage_preference, check_size_range, etc.).
   * Set false for non-finance domains to avoid confusing the LLM.
   */
  extractIndividualMandateFields: boolean;
  /**
   * Custom descriptions for the mandate fields when extractIndividualMandateFields = true.
   * Leave null to use VC defaults.
   */
  mandateFieldOverrides?: {
    investmentFocus?: string;    // default: "Specific sectors/areas they invest in"
    stagePreference?: string;    // default: "Investment stages (Seed, Series A, Growth…)"
    checkSizeRange?: string;     // default: "Typical check size ($500K–$5M)"
    investmentThesis?: string;   // default: "Personal investment philosophy"
    notableInvestments?: string; // default: "Key investments / board seats"
  };

  // ── Feature flags ────────────────────────────────────────────────────────────
  extractPeople: boolean;
  extractRelatedItems: boolean;
  extractOrganizationType: boolean;
  extractStages: boolean;
}

// ════════════════════════════════════════════════════════════════════════════════
// Built-in Profiles
// ════════════════════════════════════════════════════════════════════════════════

/**
 * VC_PROFILE — original behaviour, fully backward-compatible.
 * Use this when scraping venture capital and private equity firms.
 */
export const VC_PROFILE: ScrapeProfile = {
  id: "vc",
  name: "Venture Capital / Private Equity",

  organizationLabel: "VC firm",
  peopleLabel: "team members",
  peopleSingular: "team member",
  relatedItemsLabel: "portfolio companies",
  relatedItemsSingular: "portfolio company",
  categoriesLabel: "investment niches",
  typesLabel: "investor type",
  stagesLabel: "investment stages",

  categoryTaxonomy: [
    "Artificial Intelligence (AI) & Machine Learning (ML)",
    "SaaS",
    "FinTech",
    "Cybersecurity",
    "Cloud Computing",
    "BioTech",
    "Digital Health",
    "MedTech",
    "CleanTech",
    "Climate Tech",
    "AgriTech",
    "Robotics",
    "Quantum Computing",
    "Blockchain / Web3",
    "Consumer Internet",
    "E-Commerce",
    "EdTech",
    "PropTech",
    "Mobility / Transportation",
    "Space Technology",
    "Hardware",
    "Defense Tech",
    "Enterprise Software",
    "Marketplace",
    "Gaming",
    "Media / Content",
    "Supply Chain",
    "LegalTech",
    "HR Tech",
    "InsurTech",
  ],
  organizationTypes: [
    "Venture Capital (VC)",
    "Micro VC",
    "Angel Network",
    "Private Equity (PE)",
    "Accelerator",
    "Incubator",
    "Venture Studio",
    "Corporate Venture Capital (CVC)",
    "Family Office",
    "Venture Debt",
    "Crowdfunding Platform",
    "Government Fund",
  ],
  stages: [
    "Pre-Seed",
    "Seed",
    "Series A",
    "Series B",
    "Series C",
    "Series D+",
    "Growth / Expansion",
    "Bridge",
    "Mezzanine",
    "IPO / Public",
  ],

  peopleFunctionCategories: [
    "Partner",
    "Managing Partner",
    "General Partner",
    "Principal",
    "Associate",
    "Analyst",
    "Investment Manager",
    "Operating Partner",
    "Venture Partner",
    "Early Stage Investor",
    "Late Stage Investor",
    "Specialist",
    "Other",
  ],
  peopleSpecializationHint: "Investment focus area if mentioned (e.g. 'FinTech', 'Healthcare', 'Deep Tech')",
  extractIndividualMandateFields: true,

  extractPeople: true,
  extractRelatedItems: true,
  extractOrganizationType: true,
  extractStages: true,
};

/**
 * GENERAL_PROFILE — works for any company, agency, or organisation.
 * Extracts people (staff, leadership), services/products, and general business info.
 */
export const GENERAL_PROFILE: ScrapeProfile = {
  id: "general",
  name: "General Business / Organisation",

  organizationLabel: "company",
  peopleLabel: "team members",
  peopleSingular: "team member",
  relatedItemsLabel: "products or services",
  relatedItemsSingular: "product or service",
  categoriesLabel: "service or product categories",
  typesLabel: "business type",
  stagesLabel: null,

  categoryTaxonomy: null, // free-form — LLM picks categories from the content
  organizationTypes: null,
  stages: null,

  peopleFunctionCategories: [
    "CEO / Founder",
    "CTO / Technical Lead",
    "CFO",
    "VP / Director",
    "Manager",
    "Specialist",
    "Engineer / Developer",
    "Designer",
    "Sales / Marketing",
    "Operations",
    "Other",
  ],
  peopleSpecializationHint: "Area of expertise or specialization if mentioned (e.g. 'Machine Learning', 'Product Design')",
  extractIndividualMandateFields: false,
  mandateFieldOverrides: {
    investmentFocus: "Primary area of expertise or work",
    investmentThesis: "Professional philosophy or approach",
    notableInvestments: "Notable projects or achievements",
  },

  extractPeople: true,
  extractRelatedItems: true,
  extractOrganizationType: true,
  extractStages: false,
};

/**
 * HEALTHCARE_PROFILE — hospitals, clinics, medical practices, telehealth platforms.
 * Extracts providers/doctors, medical specialties, and locations.
 */
export const HEALTHCARE_PROFILE: ScrapeProfile = {
  id: "healthcare",
  name: "Healthcare / Medical",

  organizationLabel: "healthcare organisation",
  peopleLabel: "providers and staff",
  peopleSingular: "provider",
  relatedItemsLabel: "locations or facilities",
  relatedItemsSingular: "location",
  categoriesLabel: "medical specialties",
  typesLabel: "healthcare organisation type",
  stagesLabel: null,

  categoryTaxonomy: [
    "Primary Care",
    "Cardiology",
    "Oncology",
    "Neurology",
    "Orthopedics",
    "Pediatrics",
    "Psychiatry / Mental Health",
    "Dermatology",
    "Radiology",
    "Emergency Medicine",
    "Surgery",
    "OB/GYN",
    "Internal Medicine",
    "Physical Therapy",
    "Dentistry",
    "Ophthalmology",
    "Endocrinology",
    "Pulmonology",
    "Gastroenterology",
    "Urology",
  ],
  organizationTypes: [
    "Hospital",
    "Clinic / Outpatient",
    "Telehealth Platform",
    "Medical Practice",
    "Urgent Care",
    "Specialty Center",
    "Rehabilitation Center",
    "Long-term Care",
    "Research Institution",
    "Health System / Network",
  ],
  stages: null,

  peopleFunctionCategories: [
    "Physician / Doctor",
    "Surgeon",
    "Nurse Practitioner",
    "Physician Assistant",
    "Registered Nurse",
    "Specialist",
    "Therapist",
    "Pharmacist",
    "Administrator",
    "Other",
  ],
  peopleSpecializationHint: "Medical specialty if mentioned (e.g. 'Cardiology', 'Pediatric Oncology')",
  extractIndividualMandateFields: false,
  mandateFieldOverrides: {
    investmentFocus: "Medical specialty or clinical focus area",
    investmentThesis: "Clinical philosophy or patient care approach",
    notableInvestments: "Notable publications, awards, or procedures",
  },

  extractPeople: true,
  extractRelatedItems: true,
  extractOrganizationType: true,
  extractStages: false,
};

/**
 * ECOMMERCE_PROFILE — online retailers, marketplaces, DTC brands.
 * Extracts team/leadership, product categories, and brand info.
 */
export const ECOMMERCE_PROFILE: ScrapeProfile = {
  id: "ecommerce",
  name: "E-Commerce / Retail",

  organizationLabel: "retailer or brand",
  peopleLabel: "leadership team",
  peopleSingular: "team member",
  relatedItemsLabel: "product lines or categories",
  relatedItemsSingular: "product",
  categoriesLabel: "product categories",
  typesLabel: "retail business type",
  stagesLabel: null,

  categoryTaxonomy: null, // free-form
  organizationTypes: [
    "DTC Brand",
    "Marketplace",
    "Wholesale / B2B",
    "Subscription",
    "Luxury / Premium",
    "Discount / Value",
    "Specialty Retailer",
    "Multi-brand",
  ],
  stages: null,

  peopleFunctionCategories: [
    "CEO / Founder",
    "CMO / Marketing Lead",
    "Head of Product",
    "Head of Operations",
    "Designer / Creative",
    "Other",
  ],
  peopleSpecializationHint: "Domain of expertise (e.g. 'Brand Strategy', 'Supply Chain', 'Customer Experience')",
  extractIndividualMandateFields: false,

  extractPeople: true,
  extractRelatedItems: true,
  extractOrganizationType: true,
  extractStages: false,
};

/**
 * DIRECTORY_PROFILE — used when scraping individual entries discovered from a directory.
 * Generic enough to work for any industry entry in a listing.
 */
export const DIRECTORY_PROFILE: ScrapeProfile = {
  id: "directory_entry",
  name: "Directory Listing Entry",

  organizationLabel: "listed organisation",
  peopleLabel: "key contacts",
  peopleSingular: "contact",
  relatedItemsLabel: "services or offerings",
  relatedItemsSingular: "service",
  categoriesLabel: "categories or tags",
  typesLabel: "organisation type",
  stagesLabel: null,

  categoryTaxonomy: null,
  organizationTypes: null,
  stages: null,

  peopleFunctionCategories: [
    "Owner / Founder",
    "Manager",
    "Director",
    "Specialist",
    "Contact",
    "Other",
  ],
  peopleSpecializationHint: "Area of specialization or expertise if mentioned",
  extractIndividualMandateFields: false,

  extractPeople: true,
  extractRelatedItems: true,
  extractOrganizationType: true,
  extractStages: false,
};

/** All built-in profiles, keyed by id */
export const BUILT_IN_PROFILES: Record<string, ScrapeProfile> = {
  vc: VC_PROFILE,
  general: GENERAL_PROFILE,
  healthcare: HEALTHCARE_PROFILE,
  ecommerce: ECOMMERCE_PROFILE,
  directory_entry: DIRECTORY_PROFILE,
};

/** Look up a profile by id, falling back to VC_PROFILE */
export function getProfile(id?: string): ScrapeProfile {
  if (!id) return VC_PROFILE;
  return BUILT_IN_PROFILES[id] ?? VC_PROFILE;
}

/**
 * Map a UI template ID (from the Dashboard template picker) to a ScrapeProfile.
 * Multiple templates can share the same underlying profile.
 */
export function getProfileForTemplate(template: string): ScrapeProfile {
  const mapping: Record<string, ScrapeProfile> = {
    vc:          VC_PROFILE,
    b2b:         GENERAL_PROFILE,
    people:      DIRECTORY_PROFILE,
    healthcare:  HEALTHCARE_PROFILE,
    ecommerce:   ECOMMERCE_PROFILE,
    realestate:  GENERAL_PROFILE,
    local:       GENERAL_PROFILE,
  };
  return mapping[template] ?? GENERAL_PROFILE;
}
