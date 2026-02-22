/**
 * API Interception Strategy
 * Detects and calls JSON/GraphQL endpoints directly (10-100x faster than browser scraping)
 */

import axios from "axios";
import * as cheerio from "cheerio";

export interface ApiEndpoint {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: any;
  type: "json" | "graphql" | "rest";
}

export interface ApiInterceptionResult {
  success: boolean;
  endpoints: ApiEndpoint[];
  data?: any;
  error?: string;
}

/**
 * Detect API endpoints from HTML page
 */
export async function detectApiEndpoints(pageUrl: string, html: string): Promise<ApiEndpoint[]> {
  const endpoints: ApiEndpoint[] = [];
  const $ = cheerio.load(html);

  // Strategy 1: Look for GraphQL endpoints in script tags
  $("script").each((_, el) => {
    const scriptContent = $(el).html() || "";
    
    // GraphQL endpoint patterns
    const graphqlMatches = scriptContent.match(/["']https?:\/\/[^"']+\/graphql["']/g);
    if (graphqlMatches) {
      graphqlMatches.forEach((match) => {
        const url = match.replace(/["']/g, "");
        if (!endpoints.find((e) => e.url === url)) {
          endpoints.push({
            url,
            method: "POST",
            type: "graphql",
            headers: {
              "Content-Type": "application/json",
            },
          });
        }
      });
    }

    // REST API endpoint patterns
    const apiMatches = scriptContent.match(/["']https?:\/\/[^"']+\/api\/[^"']+["']/g);
    if (apiMatches) {
      apiMatches.forEach((match) => {
        const url = match.replace(/["']/g, "");
        if (!endpoints.find((e) => e.url === url)) {
          endpoints.push({
            url,
            method: "GET",
            type: "rest",
          });
        }
      });
    }
  });

  // Strategy 2: Common API endpoint patterns based on page URL
  const domain = new URL(pageUrl).origin;
  const commonPatterns = [
    "/api/team",
    "/api/people",
    "/api/members",
    "/api/v1/team",
    "/api/v2/team",
    "/_next/data/*/team.json",
    "/_next/data/*/people.json",
    "/wp-json/wp/v2/team",
    "/graphql",
  ];

  for (const pattern of commonPatterns) {
    const testUrl = pattern.startsWith("http") ? pattern : `${domain}${pattern}`;
    if (!endpoints.find((e) => e.url === testUrl)) {
      endpoints.push({
        url: testUrl,
        method: pattern.includes("graphql") ? "POST" : "GET",
        type: pattern.includes("graphql") ? "graphql" : pattern.includes("wp-json") ? "rest" : "json",
      });
    }
  }

  return endpoints;
}

/**
 * Try to fetch data from detected API endpoints
 */
export async function tryApiEndpoints(endpoints: ApiEndpoint[]): Promise<ApiInterceptionResult> {
  for (const endpoint of endpoints) {
    try {
      console.log(`[API Interceptor] Trying ${endpoint.type} endpoint: ${endpoint.url}`);

      let response;
      if (endpoint.method === "POST") {
        // For GraphQL, try common team queries
        const body = endpoint.type === "graphql" 
          ? {
              query: `
                query {
                  team {
                    name
                    title
                    role
                    bio
                    image
                    linkedin
                    twitter
                  }
                }
              `,
            }
          : endpoint.body;

        response = await axios.post(endpoint.url, body, {
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            ...endpoint.headers,
          },
          timeout: 5000,
        });
      } else {
        response = await axios.get(endpoint.url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            ...endpoint.headers,
          },
          timeout: 5000,
        });
      }

      // Check if response contains team/people data
      const data = response.data;
      if (typeof data === "object" && data !== null) {
        // Look for array of people/team members
        const hasTeamData = 
          Array.isArray(data) ||
          (data.data && Array.isArray(data.data)) ||
          (data.team && Array.isArray(data.team)) ||
          (data.people && Array.isArray(data.people)) ||
          (data.members && Array.isArray(data.members));

        if (hasTeamData) {
          console.log(`[API Interceptor] Found team data at ${endpoint.url}`);
          return {
            success: true,
            endpoints: [endpoint],
            data: response.data,
          };
        }
      }
    } catch (error) {
      // Endpoint doesn't exist or returned error, try next one
      continue;
    }
  }

  return {
    success: false,
    endpoints: [],
    error: "No working API endpoints found",
  };
}

/**
 * Main function: Detect and fetch from API endpoints
 */
export async function interceptApi(pageUrl: string, html: string): Promise<ApiInterceptionResult> {
  const endpoints = await detectApiEndpoints(pageUrl, html);
  
  if (endpoints.length === 0) {
    return {
      success: false,
      endpoints: [],
      error: "No API endpoints detected",
    };
  }

  console.log(`[API Interceptor] Detected ${endpoints.length} potential endpoints`);
  return await tryApiEndpoints(endpoints);
}
