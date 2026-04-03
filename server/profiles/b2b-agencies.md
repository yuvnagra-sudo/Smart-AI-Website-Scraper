---json
{
  "name": "b2b-agencies",
  "extends": "base"
}
---

# Decision Maker Tiers

DECISION MAKER SELECTION RULES (apply when extracting contact / decision maker fields):

Step 1 — Identify ALL people mentioned on this page who are employees of THIS company.
  - EXCLUDE: client names, testimonial authors, case study subjects, partner company staff, reviewers
  - INCLUDE: founders, owners, C-suite, directors, managers, developers, designers, strategists

Step 2 — Rank candidates by their likelihood to approve a B2B technology partnership:
  TIER 1 (most likely decision maker — pick first):
    CEO, Founder, Co-Founder, Owner, President, Managing Director, Managing Partner,
    Principal, Executive Director, Chief Executive Officer
  TIER 2 (technical/digital decision maker — pick if no Tier 1 available):
    CTO, Chief Technology Officer, VP Engineering, VP Technology, VP Digital,
    Director of Technology, Head of Technology, Senior Developer, Lead Developer,
    Technical Director, Director of Development, Head of Development,
    VP Product, Head of Product, Director of Digital
  TIER 3 (operational decision maker — pick if no Tier 1 or 2 available):
    COO, VP Operations, Director of Operations, General Manager,
    VP Client Services, Director of Client Services, Account Director,
    VP Strategy, Director of Strategy, Head of Strategy
  TIER 4 (creative/marketing — only if no higher tier available):
    Creative Director, Art Director, Design Director, Marketing Director,
    Brand Director, Content Director, Head of Creative
  TIER 5 (individual contributors — last resort only):
    Designer, Developer, Project Manager, Account Manager, Coordinator

Step 3 — When multiple people are at the same tier, prefer:
  - More senior title ("Senior" > "Junior", "Director" > "Manager")
  - Person with most complete information (name + title both present)
  - Person listed first on the page

Step 4 — For Decision Maker 1: pick the highest-tier person
         For Decision Maker 2: pick the second-highest-tier person (different from DM1)
         For Decision Maker 3: pick the third-highest-tier person (different from DM1 and DM2)

IMPORTANT: A "Creative Director" or "Art Director" should NEVER be chosen over a CEO, CTO,
or Senior Developer when those roles are available. Technical and executive roles outrank
creative roles for B2B technology partnership decisions.

# Field Format Hints

- Employee Count / Company Size: Look for employee count ranges like "10-49", "50-249", "250-999", "1,000-9,999" or exact numbers like "45 employees". On directories, this is often in a sidebar or structured info section labeled "Employees", "Company Size", or "Team Size". Return the range or number exactly as shown.
- Hourly Rate: Look for hourly rate ranges like "$150 - $199 / hr", "$100 - $149/hr", "$200+/hr", or "< $25/hr". On directories (Clutch, GoodFirms), this appears in a sidebar or header section. Return the exact range with currency symbol.
- Min Project Size: Look for minimum project budget like "$10,000+", "$25,000+", "$5,000+", "$1,000+", "Undisclosed". On directories, this is labeled "Min. Project Size" or "Minimum Budget". Return with dollar sign and plus sign as shown.
- Founded Year: Look for founding year like "Founded 2009", "Est. 2015", "Since 2001", or just a 4-digit year in the company info section. Return ONLY the 4-digit year (e.g. "2009"), not the full phrase.
- Location / Headquarters: Look for city, state/province, and country. Examples: "Austin, TX", "Toronto, Canada", "London, United Kingdom". On directories, check the sidebar for "Headquarters" or "Location". Return the full location string.
- Domain / Website: Return ONLY the bare domain without protocol or path. Examples: "tbkcreative.com", "example.co.uk". Do NOT include "https://" or "www." prefix or any trailing path like "/about".
- Service Lines / Focus Areas: Look for service offerings, focus areas, or specialties. On directories, these often appear with percentage breakdowns like "Web Design (40%), SEO (30%), PPC (30%)". Include the percentages if shown. On company sites, list the main services mentioned.
- Decision Maker Name: Extract the FULL NAME (first + last) of an employee. Must be an employee/founder/officer of the target company, NOT a client, reviewer, or testimonial author. Return "" if uncertain whether the person is an employee.
- Decision Maker Title: Extract the exact job title as shown on the page (e.g. "CEO", "Founder & Creative Director", "VP of Engineering"). Do not abbreviate or expand titles.
- Email: Look for email addresses in contact sections, footer, or team pages. Must be a real email (user@domain.com), not a contact form URL. Return "" if no email is explicitly shown.
- Phone: Look for phone numbers in contact sections or footer. Include country code if shown. Return the number exactly as displayed.
- Rating / Reviews: Look for numerical ratings (e.g. "4.8", "4.5/5.0") or review counts (e.g. "47 reviews"). On Clutch, look for the large rating number near the top. Return the exact number.
- Description / About: Extract the company description or tagline. Prefer the structured "About" or "Summary" section. On directories, use the company description, not individual review text.
