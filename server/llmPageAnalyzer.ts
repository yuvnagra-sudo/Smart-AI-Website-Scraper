/**
 * LLM Page Analyzer
 * 
 * Analyzes webpage content using LLM to:
 * 1. Extract relevant data (team members, portfolio companies, firm info)
 * 2. Identify URLs worth exploring for more data
 * 3. Classify page type and content quality
 * 
 * This replaces the pattern-based URL discovery with intelligent LLM-driven exploration.
 */

import { queuedLLMCall } from "./_core/llmQueue";
import { type ScrapeProfile, VC_PROFILE } from "./scrapeProfile";

/**
 * Pre-extract emails from page content before LLM analysis
 * This helps the LLM by providing a list of emails found on the page
 */
function preExtractEmails(content: string): string[] {
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const mailtoRegex = /mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
  
  const emails = new Set<string>();
  
  // Extract from mailto links
  let match;
  while ((match = mailtoRegex.exec(content)) !== null) {
    const email = match[1].toLowerCase();
    if (!isGenericEmail(email)) {
      emails.add(email);
    }
  }
  
  // Extract from text patterns
  const textMatches = content.match(emailRegex) || [];
  for (const email of textMatches) {
    const lowerEmail = email.toLowerCase();
    if (!isGenericEmail(lowerEmail)) {
      emails.add(lowerEmail);
    }
  }
  
  return Array.from(emails);
}

/**
 * Check if an email is a generic/contact email (not a personal email)
 */
function isGenericEmail(email: string): boolean {
  const genericPrefixes = [
    'info', 'contact', 'hello', 'support', 'admin', 'team', 'press',
    'media', 'careers', 'jobs', 'hr', 'sales', 'marketing', 'legal',
    'privacy', 'security', 'noreply', 'no-reply', 'webmaster', 'postmaster'
  ];
  const localPart = email.split('@')[0].toLowerCase();
  return genericPrefixes.some(prefix => localPart === prefix || localPart.startsWith(prefix + '.'));
}

/**
 * Pre-extract LinkedIn URLs from page content
 */
function preExtractLinkedInUrls(content: string): string[] {
  const linkedinRegex = /https?:\/\/(?:www\.)?linkedin\.com\/in\/[a-zA-Z0-9_-]+\/?/gi;
  const matches = content.match(linkedinRegex) || [];
  const uniqueUrls = new Set(matches.map(url => url.replace(/\/$/, '')));
  return Array.from(uniqueUrls);
}

export interface ExtractedTeamMember {
  name: string;
  title: string;
  jobFunction: string;
  specialization: string;
  email?: string;
  linkedinUrl?: string;
  profileUrl?: string; // URL to individual profile page if available
  portfolioCompanies?: string[];
  // Individual investment mandate fields
  investmentFocus?: string; // Specific sectors/areas they invest in
  stagePreference?: string; // Investment stages (Seed, Series A, Growth, etc.)
  checkSizeRange?: string; // Typical check size ($500K-$5M, etc.)
  geographicFocus?: string; // Geographic preferences (US, Europe, Global, etc.)
  investmentThesis?: string; // Personal investment philosophy
  notableInvestments?: string[]; // Key investments/board seats
  yearsExperience?: string; // Years in VC/investing
  background?: string; // Professional background before VC
}

export interface ExtractedPortfolioCompany {
  name: string;
  description?: string;
  sector?: string;
  stage?: string;
  url?: string;
}

export interface SuggestedUrl {
  url: string;
  reason: string;
  priority: 'high' | 'medium' | 'low';
  expectedContent: 'team' | 'portfolio' | 'about' | 'individual_profile' | 'other';
}

export interface ExtractedFirmData {
  description?: string;           // Brief firm description
  investmentThesis?: string;      // Investment philosophy/mandate
  aum?: string;                   // Assets under management (e.g., "$90B")
  investmentStages?: string[];    // Seed, Series A, Growth, etc.
  sectorFocus?: string[];         // Detailed list of sectors
  geographicFocus?: string[];     // Geographic preferences
  foundedYear?: string;           // Year firm was founded
  headquarters?: string;          // HQ location
}

export interface PageAnalysisResult {
  pageType: 'homepage' | 'team_listing' | 'individual_profile' | 'portfolio' | 'about' | 'other';
  contentQuality: 'high' | 'medium' | 'low' | 'none';
  
  // Extracted data
  teamMembers: ExtractedTeamMember[];
  portfolioCompanies: ExtractedPortfolioCompany[];
  firmDescription?: string;       // Legacy field for backwards compatibility
  firmData?: ExtractedFirmData;   // NEW: Structured firm data
  
  // URLs to explore next
  suggestedUrls: SuggestedUrl[];
  
  // Metadata
  hasMoreContent: boolean; // True if page has pagination, "Load More", etc.
  loadMoreSelector?: string; // CSS selector for load more button if detected
  
  // Analysis notes
  notes: string;
}

/**
 * Analyze a webpage and extract data + suggest URLs to explore
 */
export async function analyzePageWithLLM(
  pageContent: string,
  pageUrl: string,
  firmName: string,
  context: {
    visitedUrls: string[];
    currentDepth: number;
    maxDepth: number;
    goal: 'team' | 'portfolio' | 'all';
    profile?: ScrapeProfile;
  }
): Promise<PageAnalysisResult> {
  console.log(`[LLMPageAnalyzer] Analyzing page: ${pageUrl}`);
  console.log(`[LLMPageAnalyzer] Content length: ${pageContent.length} chars`);
  console.log(`[LLMPageAnalyzer] Depth: ${context.currentDepth}/${context.maxDepth}`);
  
  // Truncate content if too long (keep first 25k chars for context)
  const truncatedContent = pageContent.length > 25000 
    ? pageContent.substring(0, 25000) + "\n\n[Content truncated...]"
    : pageContent;
  
  const prompt = buildAnalysisPrompt(truncatedContent, pageUrl, firmName, context, context.profile ?? VC_PROFILE);
  
  try {
    const response = await queuedLLMCall({
      messages: [{ role: "user", content: prompt }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "page_analysis",
          strict: true,
          schema: {
            type: "object",
            properties: {
              page_type: { 
                type: "string",
                enum: ["homepage", "team_listing", "individual_profile", "portfolio", "about", "other"]
              },
              content_quality: {
                type: "string",
                enum: ["high", "medium", "low", "none"]
              },
              team_members: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    title: { type: "string" },
                    job_function: { type: "string" },
                    specialization: { type: "string" },
                    email: { type: "string" },
                    linkedin_url: { type: "string" },
                    profile_url: { type: "string" },
                    portfolio_companies: {
                      type: "array",
                      items: { type: "string" }
                    },
                    investment_focus: { type: "string" },
                    stage_preference: { type: "string" },
                    check_size_range: { type: "string" },
                    geographic_focus: { type: "string" },
                    investment_thesis: { type: "string" },
                    notable_investments: {
                      type: "array",
                      items: { type: "string" }
                    },
                    years_experience: { type: "string" },
                    background: { type: "string" }
                  },
                  required: ["name", "title", "job_function", "specialization", "email", "linkedin_url", "profile_url", "portfolio_companies", "investment_focus", "stage_preference", "check_size_range", "geographic_focus", "investment_thesis", "notable_investments", "years_experience", "background"],
                  additionalProperties: false
                }
              },
              portfolio_companies: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    description: { type: "string" },
                    sector: { type: "string" },
                    stage: { type: "string" },
                    url: { type: "string" }
                  },
                  required: ["name", "description", "sector", "stage", "url"],
                  additionalProperties: false
                }
              },
              firm_description: { type: "string" },
              firm_data: {
                type: "object",
                properties: {
                  description: { type: "string" },
                  investment_thesis: { type: "string" },
                  aum: { type: "string" },
                  investment_stages: {
                    type: "array",
                    items: { type: "string" }
                  },
                  sector_focus: {
                    type: "array",
                    items: { type: "string" }
                  },
                  geographic_focus: {
                    type: "array",
                    items: { type: "string" }
                  },
                  founded_year: { type: "string" },
                  headquarters: { type: "string" }
                },
                required: ["description", "investment_thesis", "aum", "investment_stages", "sector_focus", "geographic_focus", "founded_year", "headquarters"],
                additionalProperties: false
              },
              suggested_urls: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    url: { type: "string" },
                    reason: { type: "string" },
                    priority: { 
                      type: "string",
                      enum: ["high", "medium", "low"]
                    },
                    expected_content: {
                      type: "string",
                      enum: ["team", "portfolio", "about", "individual_profile", "other"]
                    }
                  },
                  required: ["url", "reason", "priority", "expected_content"],
                  additionalProperties: false
                }
              },
              has_more_content: { type: "boolean" },
              load_more_selector: { type: "string" },
              notes: { type: "string" }
            },
            required: [
              "page_type", "content_quality", "team_members", "portfolio_companies",
              "firm_description", "firm_data", "suggested_urls", "has_more_content", "load_more_selector", "notes"
            ],
            additionalProperties: false
          }
        }
      }
    });
    
    const content = response.choices[0]?.message?.content;
    const result = JSON.parse(typeof content === 'string' ? content : '{}');
    
    console.log(`[LLMPageAnalyzer] Page type: ${result.page_type}`);
    console.log(`[LLMPageAnalyzer] Content quality: ${result.content_quality}`);
    console.log(`[LLMPageAnalyzer] Team members found: ${result.team_members?.length || 0}`);
    console.log(`[LLMPageAnalyzer] Portfolio companies found: ${result.portfolio_companies?.length || 0}`);
    console.log(`[LLMPageAnalyzer] Suggested URLs: ${result.suggested_urls?.length || 0}`);
    
    // Filter out already visited URLs
    const filteredUrls = (result.suggested_urls || []).filter((su: any) => {
      const normalizedUrl = normalizeUrl(su.url, pageUrl);
      return !context.visitedUrls.includes(normalizedUrl);
    });
    
    console.log(`[LLMPageAnalyzer] New URLs to explore: ${filteredUrls.length}`);
    
    return {
      pageType: result.page_type || 'other',
      contentQuality: result.content_quality || 'none',
      teamMembers: (result.team_members || []).map((tm: any) => ({
        name: tm.name || '',
        title: tm.title || '',
        jobFunction: tm.job_function || '',
        specialization: tm.specialization || '',
        email: tm.email || undefined,
        linkedinUrl: tm.linkedin_url || undefined,
        profileUrl: tm.profile_url ? normalizeUrl(tm.profile_url, pageUrl) : undefined,
        portfolioCompanies: tm.portfolio_companies || [],
        investmentFocus: tm.investment_focus || undefined,
        stagePreference: tm.stage_preference || undefined,
        checkSizeRange: tm.check_size_range || undefined,
        geographicFocus: tm.geographic_focus || undefined,
        investmentThesis: tm.investment_thesis || undefined,
        notableInvestments: tm.notable_investments || [],
        yearsExperience: tm.years_experience || undefined,
        background: tm.background || undefined
      })),
      portfolioCompanies: (result.portfolio_companies || []).map((pc: any) => ({
        name: pc.name || '',
        description: pc.description || undefined,
        sector: pc.sector || undefined,
        stage: pc.stage || undefined,
        url: pc.url || undefined
      })),
      firmDescription: result.firm_description || undefined,
      firmData: result.firm_data ? {
        description: result.firm_data.description || undefined,
        investmentThesis: result.firm_data.investment_thesis || undefined,
        aum: result.firm_data.aum || undefined,
        investmentStages: result.firm_data.investment_stages || [],
        sectorFocus: result.firm_data.sector_focus || [],
        geographicFocus: result.firm_data.geographic_focus || [],
        foundedYear: result.firm_data.founded_year || undefined,
        headquarters: result.firm_data.headquarters || undefined
      } : undefined,
      suggestedUrls: filteredUrls.map((su: any) => ({
        url: normalizeUrl(su.url, pageUrl),
        reason: su.reason || '',
        priority: su.priority || 'low',
        expectedContent: su.expected_content || 'other'
      })),
      hasMoreContent: result.has_more_content || false,
      loadMoreSelector: result.load_more_selector || undefined,
      notes: result.notes || ''
    };
    
  } catch (error) {
    console.error(`[LLMPageAnalyzer] Error analyzing page:`, error);
    return {
      pageType: 'other',
      contentQuality: 'none',
      teamMembers: [],
      portfolioCompanies: [],
      suggestedUrls: [],
      hasMoreContent: false,
      notes: `Error analyzing page: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/**
 * Build the analysis prompt for the LLM.
 * The prompt language is driven by the ScrapeProfile so the same pipeline
 * works for VC firms, healthcare, e-commerce, directories, or anything else.
 */
function buildAnalysisPrompt(
  content: string,
  pageUrl: string,
  firmName: string,
  context: {
    visitedUrls: string[];
    currentDepth: number;
    maxDepth: number;
    goal: 'team' | 'portfolio' | 'all';
  },
  profile: ScrapeProfile
): string {
  const canExploreMore = context.currentDepth < context.maxDepth;

  // Pre-extract emails and LinkedIn URLs to help the LLM
  const preExtractedEmails = preExtractEmails(content);
  const preExtractedLinkedIn = preExtractLinkedInUrls(content);

  // Build hints section
  let hintsSection = '';
  if (preExtractedEmails.length > 0 || preExtractedLinkedIn.length > 0) {
    hintsSection = `\n## Pre-Extracted Contact Information (match these to ${profile.peopleLabel})\n`;
    if (preExtractedEmails.length > 0) {
      hintsSection += `**Emails found on page:** ${preExtractedEmails.join(', ')}\n`;
    }
    if (preExtractedLinkedIn.length > 0) {
      hintsSection += `**LinkedIn URLs found on page:** ${preExtractedLinkedIn.join(', ')}\n`;
    }
    hintsSection += `\nIMPORTANT: Match these emails/LinkedIn URLs to the ${profile.peopleLabel} you extract based on name patterns.\n`;
  }

  // Goal description using profile labels
  const goalDescription =
    context.goal === 'all'
      ? `${profile.peopleLabel} AND ${profile.relatedItemsLabel}`
      : context.goal === 'team'
      ? profile.peopleLabel
      : profile.relatedItemsLabel;

  // Job function categories string
  const jobFunctions = profile.peopleFunctionCategories.join(', ');

  // Individual mandate fields section — only shown for profiles that need them
  let mandateFieldsSection = '';
  if (profile.extractIndividualMandateFields) {
    const ov = profile.mandateFieldOverrides ?? {};
    const focusDesc = ov.investmentFocus ?? 'Specific sectors/areas THIS PERSON invests in';
    const stageDesc = ov.stagePreference ?? 'Investment stages this person prefers (e.g., "Seed to Series A")';
    const checkDesc = ov.checkSizeRange ?? 'Typical check size if mentioned (e.g., "$500K–$5M", "$10M+")';
    const thesisDesc = ov.investmentThesis ?? 'Their PERSONAL investment philosophy / thesis';
    const notableDesc = ov.notableInvestments ?? 'Key investments or board seats (list company names)';

    mandateFieldsSection = `
**INDIVIDUAL PROFESSIONAL DETAILS (extract if available):**
- **investment_focus**: ${focusDesc}
- **stage_preference**: ${stageDesc}
- **check_size_range**: ${checkDesc}
- **geographic_focus**: Geographic preferences if mentioned (e.g., "US, Europe", "Global")
- **investment_thesis**: ${thesisDesc}
- **notable_investments**: ${notableDesc}
- **years_experience**: Years of experience (e.g., "10+ years", "Since 2015")
- **background**: Professional background (e.g., "Former Google PM", "Founded 2 startups")`;
  } else {
    // For non-mandate profiles, repurpose these fields for generic professional info
    const ov = profile.mandateFieldOverrides ?? {};
    mandateFieldsSection = `
**PROFESSIONAL DETAILS (extract if available):**
- **investment_focus**: ${ov.investmentFocus ?? 'Primary area of expertise or specialization'}
- **stage_preference**: Seniority level or career stage if mentioned (leave empty if unclear)
- **check_size_range**: Budget or scope associated with this person's work (leave empty if not applicable)
- **geographic_focus**: Geographic focus or location preference if mentioned
- **investment_thesis**: ${ov.investmentThesis ?? 'Professional philosophy or approach to their work'}
- **notable_investments**: ${ov.notableInvestments ?? 'Notable projects, achievements, or clients'}
- **years_experience**: Years of experience if mentioned
- **background**: Professional background summary`;
  }

  // Firm/organisation info section
  const orgInfoLabel = profile.stagesLabel
    ? `${profile.organizationLabel} and its ${profile.stagesLabel}`
    : profile.organizationLabel;

  const stagesInstruction = profile.extractStages && profile.stagesLabel
    ? `- **investment_stages**: ${profile.stagesLabel} (use terms like: ${profile.stages?.join(', ') ?? 'as mentioned on the page'})`
    : `- **investment_stages**: Leave as empty array — not applicable for this type of organisation`;

  // Related items section label
  const relatedItemsPageType = profile.relatedItemsLabel.toLowerCase().includes('portfolio')
    ? 'portfolio'
    : profile.relatedItemsLabel.toLowerCase().includes('product')
    ? 'products/services'
    : profile.relatedItemsLabel;

  // URL discovery hints
  const urlDiscoveryHints = canExploreMore
    ? `Look for links that might contain more relevant data:
- ${profile.peopleLabel.charAt(0).toUpperCase() + profile.peopleLabel.slice(1)} pages (high priority)
- Individual ${profile.peopleSingular} profile pages (high priority if goal includes ${profile.peopleLabel})
- ${profile.relatedItemsLabel.charAt(0).toUpperCase() + profile.relatedItemsLabel.slice(1)} pages (high priority if goal includes ${profile.relatedItemsLabel})
- About / mission pages (medium priority)
- Regional or department-specific pages (medium priority)

For each URL, provide:
- The full URL (convert relative URLs to absolute using ${pageUrl} as base)
- Why this URL is worth exploring
- Priority (high/medium/low)
- What content you expect to find

DO NOT suggest URLs that are already visited: ${context.visitedUrls.join(', ')}`
    : 'Do not suggest any URLs - maximum exploration depth reached.';

  return `You are analyzing a webpage from a ${profile.organizationLabel}'s website to extract data and identify pages worth exploring.

## Context
- **Organisation Name:** ${firmName}
- **Organisation Type:** ${profile.organizationLabel}
- **Current Page URL:** ${pageUrl}
- **Goal:** Extract ${goalDescription}
- **Can explore more pages:** ${canExploreMore ? 'YES' : 'NO (max depth reached)'}
- **Already visited URLs:** ${context.visitedUrls.length > 0 ? context.visitedUrls.join(', ') : 'None'}${hintsSection}

## Page Content
${content}

## Your Tasks

### 1. Classify the Page
Determine what type of page this is:
- **homepage**: Main landing page
- **team_listing**: Page listing multiple ${profile.peopleLabel}
- **individual_profile**: Detailed page for a single ${profile.peopleSingular}
- **portfolio**: Page listing ${profile.relatedItemsLabel}
- **about**: About us, mission, values page
- **other**: Any other type of page

### 2. Extract ${profile.peopleLabel.charAt(0).toUpperCase() + profile.peopleLabel.slice(1)}
For each ${profile.peopleSingular} visible on this page, extract:
- **name**: Full name
- **title**: Exact job title as shown
- **job_function**: Categorize as one of: ${jobFunctions}
- **specialization**: ${profile.peopleSpecializationHint}
- **email**: Email address if visible. Look CAREFULLY for:
  - mailto: links in the HTML
  - Text patterns like name@company.com, firstname.lastname@domain.com
  - Contact sections, footer areas, "Get in touch" sections
  - Email icons or links near the person's name
- **linkedin_url**: LinkedIn profile URL if visible (look for linkedin.com/in/ links)
- **profile_url**: URL to their individual profile page on this site (if there's a "Read more" or clickable name)
- **portfolio_companies**: List of items, clients, or companies associated with this person (if mentioned)
${mandateFieldsSection}

IMPORTANT: Only extract people who are EMPLOYEES or MEMBERS of ${firmName}. Do NOT extract:
- Third-party founders, advisors, or clients
- External board members or investors
- Guest speakers or event participants

### 3. Extract ${profile.relatedItemsLabel.charAt(0).toUpperCase() + profile.relatedItemsLabel.slice(1)}
For each ${profile.relatedItemsSingular} mentioned, extract:
- **name**: Name
- **description**: Brief description if available
- **sector**: Category, sector, or type
- **stage**: Stage, phase, or tier if applicable
- **url**: Website or detail URL if available

### 4. Extract Organisation Information (important for homepage and about pages)
Extract details about ${firmName} as a ${profile.organizationLabel}:
- **description**: Brief description of the organisation (1-2 sentences)
- **investment_thesis**: The organisation's mission, philosophy, or mandate. Look for "We are...", "Our mission is...", "We focus on..."
- **aum**: Total size, revenue, or fund size if mentioned (e.g., "$90B AUM", "500+ clients", "$10M ARR")
${stagesInstruction}
- **sector_focus**: Main categories, industries, or specialties they focus on (as a list)
- **geographic_focus**: Geographic regions served or focused on (as a list)
- **founded_year**: Year founded if mentioned
- **headquarters**: Headquarters location if mentioned

### 5. Suggest URLs to Explore${canExploreMore ? '' : ' (SKIP - max depth reached)'}
${urlDiscoveryHints}

### 6. Check for Pagination/Load More
Does this page have a "Load More" button, pagination links, infinite scroll indicators, or "Show All" links?
If yes, set has_more_content to true and identify the CSS selector for the element.

### 7. Notes
Add any relevant observations about the page content, data quality, or issues encountered.

## Response Format
Return a JSON object with all the extracted data and suggestions. Use empty arrays [] for fields with no data.
For URLs, always use absolute URLs (starting with http:// or https://).
For empty string fields, use empty string "".`;
}

/**
 * Normalize a URL to absolute form
 */
function normalizeUrl(url: string, baseUrl: string): string {
  if (!url) return '';
  
  try {
    // Already absolute
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url.split('#')[0].split('?')[0].replace(/\/$/, '');
    }
    
    // Relative URL - convert to absolute
    const base = new URL(baseUrl);
    const absolute = new URL(url, base);
    return absolute.href.split('#')[0].split('?')[0].replace(/\/$/, '');
  } catch (error) {
    console.warn(`[normalizeUrl] Failed to normalize URL: ${url}`, error);
    return url;
  }
}

/**
 * Quick analysis for individual profile pages (optimized for speed)
 */
export async function analyzeProfilePageWithLLM(
  pageContent: string,
  pageUrl: string,
  personName: string,
  firmName: string
): Promise<ExtractedTeamMember | null> {
  console.log(`[LLMPageAnalyzer] Analyzing profile page for: ${personName}`);
  
  // Truncate content for profile pages (they're usually smaller)
  const truncatedContent = pageContent.length > 15000 
    ? pageContent.substring(0, 15000) + "\n\n[Content truncated...]"
    : pageContent;
  
  const prompt = `You are extracting detailed information about a team member from their profile page.

## Context
- **Person Name:** ${personName}
- **Firm Name:** ${firmName}
- **Profile URL:** ${pageUrl}

## Page Content
${truncatedContent}

## Extract the following information about ${personName}:

### Basic Information
1. **title**: Their exact job title
2. **job_function**: Categorize as: Partner, Managing Partner, General Partner, Principal, Associate, Analyst, Venture Partner, Operating Partner, or Other
3. **specialization**: Investment focus areas (e.g., "FinTech, Healthcare, SaaS")
4. **email**: Email address - look VERY carefully for:
   - mailto: links anywhere on the page
   - Text patterns like name@company.com, firstname.lastname@domain.com
   - Contact sections, sidebar, or footer
   - Social/contact icons that might link to email
   - Any email pattern that could belong to this person
5. **linkedin_url**: LinkedIn profile URL (look for linkedin.com/in/ links)

### Investment Mandate (CRITICAL - Extract if available)
6. **investment_focus**: Specific sectors/industries they focus on (e.g., "Enterprise SaaS, DevTools, Cybersecurity")
7. **stage_preference**: Investment stages they focus on (e.g., "Seed, Series A", "Growth Stage")
8. **check_size_range**: Typical investment amount or range (e.g., "$1M-$5M", "$10M+")
9. **geographic_focus**: Geographic regions they invest in (e.g., "North America", "Global", "US & Europe")
10. **investment_thesis**: Their personal investment philosophy or approach (look for "I invest in...", "I focus on...", "I believe...")
11. **notable_investments**: List of notable companies they've invested in (look for company names, logos, "Investments" section)
12. **years_experience**: Years of experience in venture capital or investing
13. **background**: Professional background before VC (e.g., "Former founder of X", "Ex-Google engineer", "Investment banking at Goldman Sachs")

### Portfolio
14. **portfolio_companies**: List of companies they've invested in or are board members of. Look for:
   - "Investments" or "Portfolio" sections
   - "Board seats" or "Board member" mentions
   - Company logos with names
   - Lists of companies under their profile

Return a JSON object with these fields. Use empty string "" for missing text fields and empty array [] for missing lists.`;

  try {
    const response = await queuedLLMCall({
      messages: [{ role: "user", content: prompt }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "profile_data",
          strict: true,
          schema: {
            type: "object",
            properties: {
              title: { type: "string" },
              job_function: { type: "string" },
              specialization: { type: "string" },
              email: { type: "string" },
              linkedin_url: { type: "string" },
              investment_focus: { type: "string" },
              stage_preference: { type: "string" },
              check_size_range: { type: "string" },
              geographic_focus: { type: "string" },
              investment_thesis: { type: "string" },
              notable_investments: {
                type: "array",
                items: { type: "string" }
              },
              years_experience: { type: "string" },
              background: { type: "string" },
              portfolio_companies: {
                type: "array",
                items: { type: "string" }
              }
            },
            required: ["title", "job_function", "specialization", "email", "linkedin_url", "investment_focus", "stage_preference", "check_size_range", "geographic_focus", "investment_thesis", "notable_investments", "years_experience", "background", "portfolio_companies"],
            additionalProperties: false
          }
        }
      }
    });
    
    const content = response.choices[0]?.message?.content;
    const result = JSON.parse(typeof content === 'string' ? content : '{}');
    
    return {
      name: personName,
      title: result.title || '',
      jobFunction: result.job_function || '',
      specialization: result.specialization || '',
      email: result.email || undefined,
      linkedinUrl: result.linkedin_url || undefined,
      profileUrl: pageUrl,
      portfolioCompanies: result.portfolio_companies || [],
      // Individual investment mandate fields
      investmentFocus: result.investment_focus || '',
      stagePreference: result.stage_preference || '',
      checkSizeRange: result.check_size_range || '',
      geographicFocus: result.geographic_focus || '',
      investmentThesis: result.investment_thesis || '',
      notableInvestments: result.notable_investments || [],
      yearsExperience: result.years_experience || '',
      background: result.background || ''
    };
    
  } catch (error) {
    console.error(`[LLMPageAnalyzer] Error analyzing profile page:`, error);
    return null;
  }
}
