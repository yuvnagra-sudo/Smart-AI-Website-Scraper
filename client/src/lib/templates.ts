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

const DIRECTORY_TEMPLATE: Template = {
  id: "directory",
  name: "Directory Listing",
  icon: "List",
  description: "Scrape companies from directory pages (GoodFirms, Clutch, G2, Yelp, etc.) — automatically visits each company's own website",
  color: "slate",
  sheets: [
    {
      key: "firms",
      label: "Companies",
      fields: [
        { key: "companyName",      label: "Company Name" },
        { key: "websiteUrl",       label: "Website" },
        { key: "description",      label: "Description" },
        { key: "investmentNiches", label: "Services / Products" },
        { key: "aum",              label: "Team Size" },
        { key: "headquarters",     label: "Location" },
        { key: "foundedYear",      label: "Founded" },
        { key: "investorType",     label: "Key Contact" },
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
  DIRECTORY_TEMPLATE,
];

const TEMPLATE_MAP = new Map<string, Template>(ALL_TEMPLATES.map(t => [t.id, t]));

export function getTemplate(id: string): Template {
  return TEMPLATE_MAP.get(id) ?? VC_TEMPLATE;
}

// ─── Agent-pipeline section definitions for non-VC templates ─────────────────

export interface AgentSection { key: string; label: string; desc: string; }

export const TEMPLATE_SECTIONS: Record<string, AgentSection[]> = {
  b2b: [
    { key: "industry_vertical",    label: "Industry / Vertical",     desc: "What industry or vertical does this company operate in? (e.g. SaaS, Fintech, Healthcare IT)" },
    { key: "business_model",       label: "Business Model",          desc: "How does the company make money? (SaaS, services, marketplace, agency, etc.)" },
    { key: "company_size",         label: "Company Size",            desc: "Employee count, revenue range, or funding stage if mentioned on the website" },
    { key: "products_services",    label: "Products & Services",     desc: "Specific products, services, or solutions the company offers — be concrete" },
    { key: "target_customers",     label: "Target Customers / ICP",  desc: "Who are their ideal customers? List industries, company sizes, or roles they serve" },
    { key: "key_decision_makers",  label: "Key Decision Makers",     desc: "Names and titles of founders, CEO, CTO, VP Sales, or other C-suite / VP contacts" },
    { key: "value_proposition",    label: "Value Proposition",       desc: "What is their core value prop or primary differentiator from competitors?" },
    { key: "notable_clients",      label: "Notable Clients",         desc: "Well-known customers or brands featured in case studies, logos, or testimonials" },
    { key: "funding_investors",    label: "Funding & Investors",     desc: "Funding stage, total raised, and notable investors if disclosed" },
    { key: "hq_location",          label: "HQ Location",             desc: "Headquarters city and country" },
    { key: "founded_year",         label: "Founded Year",            desc: "Year the company was founded" },
  ],
  people: [
    { key: "current_title",        label: "Current Title",           desc: "Person's current job title (e.g. VP of Engineering, Founder, Partner)" },
    { key: "current_company",      label: "Current Company",         desc: "Name of the company or organization they currently work at" },
    { key: "career_background",    label: "Career Background",       desc: "Key past employers, roles held, and total years of professional experience" },
    { key: "skills_expertise",     label: "Skills & Expertise",      desc: "Domain expertise, technical skills, or key areas of professional focus" },
    { key: "education",            label: "Education",               desc: "Highest degree, institution, and field of study if visible" },
    { key: "linkedin_url",         label: "LinkedIn URL",            desc: "LinkedIn profile URL if findable on the page or linked" },
    { key: "contact_info",         label: "Contact Info",            desc: "Email address or other publicly listed contact details" },
    { key: "location",             label: "Location",                desc: "City and country they are based in" },
    { key: "notable_work",         label: "Notable Accomplishments", desc: "Major achievements, publications, awards, or well-known projects" },
  ],
  healthcare: [
    { key: "facility_type",        label: "Facility Type",           desc: "Type of healthcare facility: hospital, outpatient clinic, private practice, surgery center, telehealth, etc." },
    { key: "specialties",          label: "Medical Specialties",     desc: "All clinical specialties or departments offered (e.g. Cardiology, Orthopedics, Pediatrics)" },
    { key: "staff_size",           label: "Staff / Physician Count", desc: "Number of physicians, practitioners, or overall headcount if stated" },
    { key: "services_offered",     label: "Services Offered",        desc: "Specific treatments, procedures, diagnostics, or programs available" },
    { key: "insurance_accepted",   label: "Insurance Accepted",      desc: "Insurance plans, payers, or networks accepted; note if self-pay is available" },
    { key: "patient_population",   label: "Patient Population",      desc: "Who they treat: adults, pediatric, geriatric, specific conditions, underserved communities, etc." },
    { key: "affiliated_systems",   label: "Health System Affiliations", desc: "Hospital networks, health systems, or academic medical centers they are affiliated with" },
    { key: "location_hours",       label: "Location & Hours",        desc: "Full address, phone, and operating hours" },
  ],
  ecommerce: [
    { key: "product_categories",   label: "Product Categories",      desc: "Main product types or categories sold — be specific (e.g. 'organic skincare', 'men's athletic apparel')" },
    { key: "price_range",          label: "Price Range",             desc: "Typical product price range or average order value if visible" },
    { key: "brand_positioning",    label: "Brand Positioning",       desc: "How does the brand position itself? (luxury, budget, sustainable, niche, etc.)" },
    { key: "unique_selling_points",label: "Unique Selling Points",   desc: "What makes this store unique vs competitors? Feature claims, certifications, exclusives" },
    { key: "shipping_policy",      label: "Shipping & Fulfillment",  desc: "Shipping speeds, carriers, free shipping threshold, international availability" },
    { key: "return_policy",        label: "Return Policy",           desc: "Return/exchange/refund policy details and time window" },
    { key: "customer_ratings",     label: "Customer Ratings",        desc: "Star rating, number of reviews, or notable customer testimonials if shown" },
    { key: "target_demographics",  label: "Target Demographics",     desc: "Primary customer demographic: age range, gender, lifestyle, geography" },
    { key: "social_presence",      label: "Social Media Channels",   desc: "Social platforms linked and approximate follower counts if shown" },
  ],
  realestate: [
    { key: "agency_type",          label: "Agency Type",             desc: "Residential, commercial, luxury, property management, buyer's agency, full-service, etc." },
    { key: "service_areas",        label: "Service Areas",           desc: "Cities, neighborhoods, counties, or regions the agency actively covers" },
    { key: "property_specialties", label: "Property Specialties",    desc: "Types of properties handled: single-family, condos, multi-family, office, retail, industrial, etc." },
    { key: "price_range",          label: "Listing Price Range",     desc: "Typical or advertised listing price range (e.g. $200K–$800K)" },
    { key: "agent_count",          label: "Number of Agents",        desc: "Total number of agents or team size listed on the website" },
    { key: "top_agents",           label: "Top / Featured Agents",   desc: "Names and specializations of featured or top-producing agents" },
    { key: "recent_sales",         label: "Recent Sales / Volume",   desc: "Recent closed deals, transaction volume, or sales stats highlighted on the site" },
    { key: "differentiators",      label: "Differentiators",         desc: "Awards, certifications, unique services (e.g. virtual tours, off-market listings), or brand claims" },
  ],
  local: [
    { key: "business_category",    label: "Business Category",       desc: "Specific type of local business (e.g. Italian restaurant, auto repair shop, yoga studio)" },
    { key: "services_menu",        label: "Services / Menu",         desc: "Core offerings, menu items, service packages, or treatments available" },
    { key: "hours",                label: "Hours of Operation",      desc: "Days and times open; note seasonal variations or holiday hours if listed" },
    { key: "price_range",          label: "Price Range",             desc: "Price tier ($, $$, $$$, $$$$) or typical cost for a standard purchase/service" },
    { key: "ratings_reviews",      label: "Ratings & Reviews",       desc: "Star rating, review count, and key themes from customer feedback" },
    { key: "amenities_features",   label: "Amenities / Features",    desc: "Parking, delivery, takeout, outdoor seating, ADA accessibility, appointment required, etc." },
    { key: "contact_location",     label: "Contact & Location",      desc: "Street address, phone, email, and any booking or reservation links" },
  ],
  directory: [
    { key: "company_name",         label: "Company Name",            desc: "Full legal or trading name of the company (from their own website)" },
    { key: "website",              label: "Website",                 desc: "The company's own website URL (not the directory URL)" },
    { key: "description",          label: "Description",             desc: "What the company does — their core offering or value proposition" },
    { key: "services",             label: "Services / Products",     desc: "Specific services or products they offer" },
    { key: "team_size",            label: "Team Size",               desc: "Number of employees or size indicator (e.g. '10–49', '~200 staff')" },
    { key: "location",             label: "Location",                desc: "Headquarters city, country, or region" },
    { key: "founded",              label: "Founded",                 desc: "Year the company was founded, if available" },
    { key: "key_contact",          label: "Key Contact",             desc: "Name and title of the primary contact or decision maker listed on the site" },
  ],
};

export const TEMPLATE_SYSTEM_PROMPTS: Record<string, string> = {
  b2b:        "You are a B2B business intelligence analyst. For each company website, extract the requested fields. Focus on business model, product offering, target market, team leadership, and customer evidence. Be specific and concrete — avoid vague summaries. Return ONLY valid JSON with one key per requested field.",
  people:     "You are a professional profile researcher. For each person's profile page, bio, or LinkedIn, extract the requested fields. Focus on concrete facts: titles, companies, achievements. Return ONLY valid JSON with one key per requested field.",
  healthcare: "You are a healthcare market researcher. For each provider website, extract the requested fields about the facility, clinical specialties, staff, and patient services. Be factual and specific. Return ONLY valid JSON with one key per requested field.",
  ecommerce:  "You are an e-commerce competitive analyst. For each online store, extract the requested fields about products, pricing, brand positioning, and customer experience. Return ONLY valid JSON with one key per requested field.",
  realestate: "You are a real estate market analyst. For each agency website, extract the requested fields about property types, service areas, agents, and recent activity. Return ONLY valid JSON with one key per requested field.",
  local:      "You are a local business researcher. For each business website or listing page, extract the requested fields about services, hours, pricing, and customer feedback. Return ONLY valid JSON with one key per requested field.",
  directory:  "You are a business researcher analyzing companies sourced from directory listings. The scraper automatically visits each company's own website (not the directory page). Extract the requested fields from the company's native website. Be specific and factual — use what's actually stated on the site. Return ONLY valid JSON with one key per requested field.",
};
