/**
 * Smart URL Constructor and Validator
 * Generates and validates LinkedIn profile URLs
 */

import axios from "axios";
// Removed: import { invokeLLM } from "./_core/llm"; - Now using OpenAI only via llmQueue
import { queuedLLMCall } from "./_core/llmQueue";

interface URLVariation {
  url: string;
  confidence: "High" | "Medium" | "Low";
  method: string;
}

/**
 * Nickname database for common name variations
 */
const NICKNAME_MAP: Record<string, string[]> = {
  // Male names
  "robert": ["bob", "rob", "bobby"],
  "william": ["bill", "will", "billy"],
  "richard": ["rick", "dick", "rich"],
  "james": ["jim", "jimmy", "jamie"],
  "michael": ["mike", "mikey"],
  "christopher": ["chris"],
  "matthew": ["matt"],
  "daniel": ["dan", "danny"],
  "joseph": ["joe", "joey"],
  "anthony": ["tony"],
  "thomas": ["tom", "tommy"],
  "charles": ["chuck", "charlie"],
  "david": ["dave", "davey"],
  "andrew": ["andy", "drew"],
  "benjamin": ["ben", "benny"],
  "alexander": ["alex"],
  "jonathan": ["jon", "johnny"],
  "nicholas": ["nick"],
  "samuel": ["sam"],
  "timothy": ["tim"],
  
  // Female names
  "elizabeth": ["liz", "beth", "betty", "lizzie"],
  "katherine": ["kate", "katie", "kathy"],
  "margaret": ["maggie", "meg", "peggy"],
  "jennifer": ["jen", "jenny"],
  "jessica": ["jess"],
  "patricia": ["pat", "patty", "tricia"],
  "rebecca": ["becky", "becca"],
  "deborah": ["deb", "debbie"],
  "susan": ["sue", "susie"],
  "christine": ["chris", "christina"],
  "kimberly": ["kim"],
  "michelle": ["mich", "shelly"],
  "amanda": ["mandy"],
  "stephanie": ["steph"],
  "victoria": ["vicky", "tori"],
};

/**
 * Get nickname variations for a name
 */
export function getNicknameVariations(name: string): string[] {
  const nameLower = name.toLowerCase();
  const variations: string[] = [name];
  
  // Check if this is a nickname that maps to a full name
  for (const [fullName, nicknames] of Object.entries(NICKNAME_MAP)) {
    if (nicknames.includes(nameLower)) {
      variations.push(fullName);
      variations.push(...nicknames.filter(n => n !== nameLower));
      break;
    }
    if (fullName === nameLower) {
      variations.push(...nicknames);
      break;
    }
  }
  
  return variations;
}

/**
 * Generate LinkedIn URL variations for a person's name
 */
export function generateLinkedInURLVariations(fullName: string): URLVariation[] {
  const variations: URLVariation[] = [];
  const seenSlugs = new Set<string>();
  
  // Parse name
  const parts = fullName.trim().split(/\s+/).filter(p => p.length > 0);
  if (parts.length === 0) return [];
  
  const first = parts[0].toLowerCase();
  const last = parts[parts.length - 1].toLowerCase();
  const middle = parts.length > 2 ? parts.slice(1, -1) : [];
  
  // Get nickname variations for first name
  const firstVariations = getNicknameVariations(first);
  
  // Generate patterns for each first name variation
  for (const firstVar of firstVariations) {
    const isNickname = firstVar !== first;
    const baseConfidence: "High" | "Medium" | "Low" = isNickname ? "Medium" : "High";
    
    // Pattern 1: first-last
    const slug1 = `${firstVar}-${last}`;
    if (!seenSlugs.has(slug1)) {
      seenSlugs.add(slug1);
      variations.push({
        url: `https://www.linkedin.com/in/${slug1}`,
        confidence: baseConfidence,
        method: "first-last",
      });
    }
    
    // Pattern 2: firstlast (no dash)
    const slug2 = `${firstVar}${last}`;
    if (!seenSlugs.has(slug2)) {
      seenSlugs.add(slug2);
      variations.push({
        url: `https://www.linkedin.com/in/${slug2}`,
        confidence: "Medium",
        method: "firstlast",
      });
    }
    
    // Pattern 3: first.last
    const slug3 = `${firstVar}.${last}`;
    if (!seenSlugs.has(slug3)) {
      seenSlugs.add(slug3);
      variations.push({
        url: `https://www.linkedin.com/in/${slug3}`,
        confidence: "Low",
        method: "first.last",
      });
    }
    
    // Pattern 4: f-last (first initial)
    const slug4 = `${firstVar[0]}-${last}`;
    if (!seenSlugs.has(slug4)) {
      seenSlugs.add(slug4);
      variations.push({
        url: `https://www.linkedin.com/in/${slug4}`,
        confidence: "Low",
        method: "f-last",
      });
    }
    
    // Pattern 5: first-middle-last (if middle name exists)
    if (middle.length > 0) {
      for (const mid of middle) {
        const midLower = mid.toLowerCase();
        
        // Full middle name
        const slug5 = `${firstVar}-${midLower}-${last}`;
        if (!seenSlugs.has(slug5)) {
          seenSlugs.add(slug5);
          variations.push({
            url: `https://www.linkedin.com/in/${slug5}`,
            confidence: "Medium",
            method: "first-middle-last",
          });
        }
        
        // Middle initial
        const slug6 = `${firstVar}-${midLower[0]}-${last}`;
        if (!seenSlugs.has(slug6)) {
          seenSlugs.add(slug6);
          variations.push({
            url: `https://www.linkedin.com/in/${slug6}`,
            confidence: "Medium",
            method: "first-m-last",
          });
        }
      }
    }
    
    // Pattern 6: With numbers (common when name is taken)
    for (let num = 1; num <= 3; num++) {
      const slug7 = `${firstVar}-${last}-${num}`;
      if (!seenSlugs.has(slug7)) {
        seenSlugs.add(slug7);
        variations.push({
          url: `https://www.linkedin.com/in/${slug7}`,
          confidence: "Low",
          method: `first-last-${num}`,
        });
      }
    }
  }
  
  return variations;
}

/**
 * Validate if a LinkedIn URL exists (without full scraping)
 */
export async function validateLinkedInURL(url: string): Promise<boolean> {
  try {
    // Use HEAD request for speed
    const response = await axios.head(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      timeout: 5000,
      maxRedirects: 5,
      validateStatus: (status) => status < 500, // Don't throw on 4xx
    });
    
    // 200 = exists, 404 = doesn't exist, 999 = LinkedIn blocking (assume exists)
    return response.status === 200 || response.status === 999;
    
  } catch (error: any) {
    // If we get a 999 or connection error, LinkedIn might be blocking us
    // In this case, we can't validate, so return false
    if (error.response?.status === 999) {
      return true; // LinkedIn uses 999 to block scrapers, but profile might exist
    }
    return false;
  }
}

/**
 * Validate multiple URLs in parallel with rate limiting
 */
export async function validateMultipleURLs(
  urls: string[],
  maxConcurrent: number = 5
): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();
  
  // Process in batches to avoid rate limiting
  for (let i = 0; i < urls.length; i += maxConcurrent) {
    const batch = urls.slice(i, i + maxConcurrent);
    
    const batchResults = await Promise.all(
      batch.map(async (url) => ({
        url,
        exists: await validateLinkedInURL(url),
      }))
    );
    
    for (const { url, exists } of batchResults) {
      results.set(url, exists);
    }
    
    // Small delay between batches to be respectful
    if (i + maxConcurrent < urls.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  return results;
}

/**
 * Use AI to generate additional name variations
 */
export async function generateAINameVariations(fullName: string): Promise<string[]> {
  const prompt = `Given the name "${fullName}", generate likely variations that might be used on LinkedIn profiles.

Consider:
- Nicknames (e.g., Bob for Robert, Bill for William)
- Professional vs casual names
- Cultural name variations
- Common abbreviations
- Middle name usage

Return ONLY a JSON array of name variations, nothing else.
Example: ["Robert Smith", "Bob Smith", "R. Smith"]`;

  try {
    const response = await queuedLLMCall({
      messages: [{ role: "user", content: prompt }],
    });
    
    const content = response.choices[0]?.message?.content;
    if (!content || typeof content !== 'string') return [];
    
    // Try to parse as JSON
    const match = content.match(/\[.*\]/);
    if (match) {
      const variations = JSON.parse(match[0]);
      return Array.isArray(variations) ? variations : [];
    }
    
    return [];
  } catch (error) {
    console.error("[AI Name Variations] Error:", error);
    return [];
  }
}

/**
 * Main function: Generate and validate LinkedIn URLs for a person
 */
export async function findLinkedInURLForPerson(
  fullName: string,
  useAI: boolean = false
): Promise<URLVariation | null> {
  console.log(`[Smart URL] Finding LinkedIn URL for: ${fullName}`);
  
  // Step 1: Generate variations
  let variations = generateLinkedInURLVariations(fullName);
  
  // Step 2: Optionally use AI for additional variations
  if (useAI) {
    const aiVariations = await generateAINameVariations(fullName);
    for (const aiName of aiVariations) {
      const aiUrls = generateLinkedInURLVariations(aiName);
      variations.push(...aiUrls);
    }
  }
  
  // Step 3: Sort by confidence (High first)
  variations.sort((a, b) => {
    const confidenceOrder = { "High": 0, "Medium": 1, "Low": 2 };
    return confidenceOrder[a.confidence] - confidenceOrder[b.confidence];
  });
  
  // Step 4: Validate in order until we find one that exists
  for (const variation of variations) {
    const exists = await validateLinkedInURL(variation.url);
    if (exists) {
      console.log(`[Smart URL] ✓ Found valid URL: ${variation.url} (${variation.method})`);
      return variation;
    }
    
    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  console.log(`[Smart URL] ✗ No valid LinkedIn URL found for: ${fullName}`);
  return null;
}
