/**
 * Industry Template Definitions
 *
 * Each template maps a UI concept (id + display info) to a set of output sheets
 * and human-readable column labels. The field keys map directly to database columns
 * so the results sheet can render them without any extra transformation.
 */

export interface TemplateField {
  key: string;     // DB column name
  label: string;   // Human-readable column header shown in the results sheet
}

export interface TemplateSheet {
  key: string;     // Unique sheet identifier
  label: string;   // Tab label shown in UI
  fields: TemplateField[];
}

export interface Template {
  id: string;
  name: string;
  icon: string;          // lucide-react icon name (string so no runtime import needed)
  description: string;
  color: string;         // Tailwind color name (e.g. "blue", "emerald")
  sheets: TemplateSheet[];
}

// ---------------------------------------------------------------------------
// Template definitions
// ---------------------------------------------------------------------------

const VC_TEMPLATE: Template = {
  id: "vc",
  name: "VC / Investors",
  icon: "TrendingUp",
  description: "Fund details, partner profiles, portfolio companies, and investment thesis",
  color: "violet",
  sheets: [
    {
      key: "firms",
      label: "VC Firms",
      fields: [
        { key: "companyName",              label: "Firm Name" },
        { key: "websiteUrl",               label: "Website" },
        { key: "description",              label: "Description" },
        { key: "investorType",             label: "Investor Type" },
        { key: "investmentStages",         label: "Investment Stages" },
        { key: "investmentNiches",         label: "Focus Areas" },
        { key: "aum",                      label: "AUM" },
        { key: "foundedYear",              label: "Founded" },
        { key: "headquarters",             label: "Headquarters" },
        { key: "investmentThesis",         label: "Investment Thesis" },
        { key: "websiteVerified",          label: "Website Verified" },
      ],
    },
    {
      key: "team",
      label: "Partners & Team",
      fields: [
        { key: "vcFirm",             label: "Firm" },
        { key: "name",               label: "Name" },
        { key: "title",              label: "Title" },
        { key: "decisionMakerTier",  label: "Tier" },
        { key: "linkedinUrl",        label: "LinkedIn" },
        { key: "email",              label: "Email" },
        { key: "investmentFocus",    label: "Investment Focus" },
        { key: "stagePreference",    label: "Stage Preference" },
        { key: "checkSizeRange",     label: "Check Size" },
        { key: "geographicFocus",    label: "Geography" },
        { key: "notableInvestments", label: "Notable Investments" },
        { key: "background",         label: "Background" },
      ],
    },
    {
      key: "portfolio",
      label: "Portfolio Companies",
      fields: [
        { key: "vcFirm",            label: "Investor" },
        { key: "portfolioCompany",  label: "Company" },
        { key: "investmentDate",    label: "Investment Date" },
        { key: "websiteUrl",        label: "Website" },
        { key: "investmentNiche",   label: "Sector" },
        { key: "recencyCategory",   label: "Recency" },
      ],
    },
  ],
};

const B2B_TEMPLATE: Template = {
  id: "b2b",
  name: "B2B Companies",
  icon: "Building2",
  description: "Company profiles, key contacts, and clients / case studies",
  color: "blue",
  sheets: [
    {
      key: "firms",
      label: "Organizations",
      fields: [
        { key: "companyName",      label: "Company Name" },
        { key: "websiteUrl",       label: "Website" },
        { key: "description",      label: "About" },
        { key: "investorType",     label: "Organization Type" },
        { key: "investmentNiches", label: "Industry Tags" },
        { key: "headquarters",     label: "Location" },
        { key: "foundedYear",      label: "Founded" },
        { key: "aum",              label: "Revenue / Size" },
        { key: "sectorFocus",      label: "Sectors Served" },
        { key: "geographicFocus",  label: "Markets" },
      ],
    },
    {
      key: "team",
      label: "Key People",
      fields: [
        { key: "vcFirm",            label: "Company" },
        { key: "name",              label: "Name" },
        { key: "title",             label: "Title" },
        { key: "jobFunction",       label: "Function" },
        { key: "linkedinUrl",       label: "LinkedIn" },
        { key: "email",             label: "Email" },
        { key: "specialization",    label: "Specialization" },
        { key: "background",        label: "Background" },
      ],
    },
    {
      key: "portfolio",
      label: "Clients / Case Studies",
      fields: [
        { key: "vcFirm",           label: "Company" },
        { key: "portfolioCompany", label: "Client / Project" },
        { key: "investmentNiche",  label: "Industry" },
        { key: "investmentDate",   label: "Year" },
        { key: "websiteUrl",       label: "Reference URL" },
      ],
    },
  ],
};

const PEOPLE_TEMPLATE: Template = {
  id: "people",
  name: "People & Profiles",
  icon: "Users",
  description: "Individual profiles — executives, consultants, researchers, or any named contact",
  color: "amber",
  sheets: [
    {
      key: "team",
      label: "People",
      fields: [
        { key: "name",              label: "Name" },
        { key: "vcFirm",           label: "Organization" },
        { key: "title",             label: "Title / Role" },
        { key: "decisionMakerTier", label: "Seniority Level" },
        { key: "jobFunction",       label: "Function" },
        { key: "specialization",    label: "Specialization" },
        { key: "linkedinUrl",       label: "LinkedIn" },
        { key: "email",             label: "Email" },
        { key: "geographicFocus",   label: "Location" },
        { key: "background",        label: "Background" },
        { key: "yearsExperience",   label: "Experience" },
        { key: "notableInvestments",label: "Notable Work" },
      ],
    },
    {
      key: "firms",
      label: "Organizations",
      fields: [
        { key: "companyName",  label: "Organization Name" },
        { key: "websiteUrl",   label: "Website" },
        { key: "description",  label: "About" },
        { key: "investorType", label: "Type" },
        { key: "headquarters", label: "Location" },
      ],
    },
  ],
};

const HEALTHCARE_TEMPLATE: Template = {
  id: "healthcare",
  name: "Healthcare",
  icon: "HeartPulse",
  description: "Hospitals, clinics, practitioners, and healthcare organizations",
  color: "rose",
  sheets: [
    {
      key: "firms",
      label: "Organizations",
      fields: [
        { key: "companyName",      label: "Organization Name" },
        { key: "websiteUrl",       label: "Website" },
        { key: "description",      label: "Overview" },
        { key: "investorType",     label: "Facility Type" },
        { key: "investmentNiches", label: "Specialties" },
        { key: "headquarters",     label: "Location" },
        { key: "sectorFocus",      label: "Services Offered" },
        { key: "geographicFocus",  label: "Service Area" },
      ],
    },
    {
      key: "team",
      label: "Practitioners",
      fields: [
        { key: "vcFirm",         label: "Organization" },
        { key: "name",           label: "Name" },
        { key: "title",          label: "Title" },
        { key: "jobFunction",    label: "Role" },
        { key: "investmentFocus",label: "Medical Specialty" },
        { key: "linkedinUrl",    label: "Profile URL" },
        { key: "email",          label: "Contact" },
        { key: "background",     label: "Credentials" },
      ],
    },
  ],
};

const ECOMMERCE_TEMPLATE: Template = {
  id: "ecommerce",
  name: "E-Commerce",
  icon: "ShoppingCart",
  description: "Online stores, product categories, pricing, and key contacts",
  color: "orange",
  sheets: [
    {
      key: "firms",
      label: "Stores",
      fields: [
        { key: "companyName",       label: "Store Name" },
        { key: "websiteUrl",        label: "Website" },
        { key: "description",       label: "About" },
        { key: "investorType",      label: "Store Type" },
        { key: "investmentNiches",  label: "Product Categories" },
        { key: "headquarters",      label: "Location" },
        { key: "geographicFocus",   label: "Ships To" },
        { key: "aum",               label: "Est. Revenue" },
      ],
    },
    {
      key: "portfolio",
      label: "Products / Listings",
      fields: [
        { key: "vcFirm",           label: "Store" },
        { key: "portfolioCompany", label: "Product / Category" },
        { key: "investmentNiche",  label: "Category" },
        { key: "websiteUrl",       label: "Listing URL" },
        { key: "investmentDate",   label: "Listed" },
      ],
    },
    {
      key: "team",
      label: "Contacts",
      fields: [
        { key: "vcFirm",    label: "Store" },
        { key: "name",      label: "Name" },
        { key: "title",     label: "Role" },
        { key: "email",     label: "Email" },
        { key: "linkedinUrl", label: "LinkedIn" },
      ],
    },
  ],
};

const REALESTATE_TEMPLATE: Template = {
  id: "realestate",
  name: "Real Estate",
  icon: "Home",
  description: "Agencies, agents, listings, and property data",
  color: "teal",
  sheets: [
    {
      key: "firms",
      label: "Agencies",
      fields: [
        { key: "companyName",      label: "Agency Name" },
        { key: "websiteUrl",       label: "Website" },
        { key: "description",      label: "About" },
        { key: "investorType",     label: "Agency Type" },
        { key: "investmentNiches", label: "Property Types" },
        { key: "headquarters",     label: "Location" },
        { key: "geographicFocus",  label: "Markets Served" },
        { key: "aum",              label: "Portfolio Size" },
      ],
    },
    {
      key: "team",
      label: "Agents",
      fields: [
        { key: "vcFirm",         label: "Agency" },
        { key: "name",           label: "Agent Name" },
        { key: "title",          label: "Title" },
        { key: "email",          label: "Email" },
        { key: "linkedinUrl",    label: "Profile URL" },
        { key: "specialization", label: "Specialty" },
        { key: "geographicFocus",label: "Territory" },
        { key: "background",     label: "Experience" },
      ],
    },
    {
      key: "portfolio",
      label: "Listings",
      fields: [
        { key: "vcFirm",           label: "Agency" },
        { key: "portfolioCompany", label: "Property" },
        { key: "investmentNiche",  label: "Type" },
        { key: "websiteUrl",       label: "Listing URL" },
        { key: "investmentDate",   label: "Listed / Sold" },
      ],
    },
  ],
};

const LOCAL_TEMPLATE: Template = {
  id: "local",
  name: "Local Businesses",
  icon: "MapPin",
  description: "Restaurants, shops, services, and community businesses",
  color: "green",
  sheets: [
    {
      key: "firms",
      label: "Businesses",
      fields: [
        { key: "companyName",      label: "Business Name" },
        { key: "websiteUrl",       label: "Website" },
        { key: "description",      label: "About" },
        { key: "investorType",     label: "Business Type" },
        { key: "investmentNiches", label: "Categories" },
        { key: "headquarters",     label: "Address" },
        { key: "geographicFocus",  label: "Service Area" },
      ],
    },
    {
      key: "team",
      label: "Contacts",
      fields: [
        { key: "vcFirm",      label: "Business" },
        { key: "name",        label: "Contact Name" },
        { key: "title",       label: "Role" },
        { key: "email",       label: "Email" },
        { key: "linkedinUrl", label: "Profile URL" },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const ALL_TEMPLATES: Template[] = [
  VC_TEMPLATE,
  B2B_TEMPLATE,
  PEOPLE_TEMPLATE,
  HEALTHCARE_TEMPLATE,
  ECOMMERCE_TEMPLATE,
  REALESTATE_TEMPLATE,
  LOCAL_TEMPLATE,
];

const TEMPLATE_MAP = new Map<string, Template>(ALL_TEMPLATES.map(t => [t.id, t]));

export function getTemplate(id: string): Template {
  return TEMPLATE_MAP.get(id) ?? VC_TEMPLATE;
}
