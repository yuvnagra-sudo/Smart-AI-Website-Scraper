/**
 * Investment Niche Taxonomy for VC Prospect Research
 * This module contains the predefined taxonomy of investment niches used for categorizing
 * VC firms and their portfolio companies.
 */

export const INVESTMENT_NICHES = {
  "Technology / Software": {
    "Artificial Intelligence (AI) & Machine Learning (ML)": [
      "Generative AI",
      "AI-driven Healthcare",
      "AI in Cybersecurity",
      "AI in Education (EdTech)",
      "AI Agents & Autonomous Systems",
    ],
    "Software as a Service (SaaS)": ["Enterprise Software", "B2B Software"],
    Cybersecurity: ["Threat Detection & Response", "Data Security", "Confidential AI"],
    "Financial Technology (FinTech)": [
      "Decentralized Finance (DeFi) / Blockchain",
      "Digital Payments & Lending",
      "InsurTech",
    ],
    "Cloud Computing & Infrastructure": [],
    "Internet & Digital Media": [
      "E-commerce & Marketplaces",
      "Social Media & Consumer Tech",
      "Media & Entertainment",
    ],
  },
  "Healthcare & Life Sciences": {
    "Biotechnology (BioTech)": ["Gene Therapy & Personalized Medicine"],
    "Digital Health & HealthTech": ["Telemedicine / Remote Healthcare", "Health & Wellness Apps"],
    "Medical Devices & Equipment": [],
    "Women's Health (FemTech)": [],
  },
  "Green Technology & Sustainability": {
    "Clean Technology (CleanTech)": [
      "Renewable Energy (Solar, Wind)",
      "Energy Storage & Battery Technology",
      "Electric Vehicles (EVs)",
    ],
    Sustainability: [
      "Carbon Capture",
      "Alternative Proteins & Food Tech",
      "Circular Economy & Eco-friendly Packaging",
    ],
    "Agricultural Technology (AgriTech)": ["Vertical Farming"],
  },
  "Advanced & Frontier Technologies": {
    "Advanced Computing": ["Quantum Computing", "Semiconductors"],
    "Robotics & Automation": ["Cobots (Collaborative Robots)"],
    "Aerospace & Transportation": [],
    "Deep Tech": [],
  },
} as const;

export function formatNichesForPrompt(): string {
  const result: string[] = [];

  for (const [category, subcategories] of Object.entries(INVESTMENT_NICHES)) {
    result.push(`\n${category}:`);

    for (const [subcategory, subNiches] of Object.entries(subcategories)) {
      result.push(`  - ${subcategory}`);

      for (const subNiche of subNiches) {
        result.push(`    - ${subNiche}`);
      }
    }
  }

  return result.join("\n");
}
