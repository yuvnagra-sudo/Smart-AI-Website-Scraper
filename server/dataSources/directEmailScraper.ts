/**
 * Direct Email Scraper
 * --------------------
 * Zero-cost Step 0 in the enrichment cascade.
 *
 * Ported from scrape_emails.py — hits 18 common paths on a domain
 * (/, /contact, /about, /team, etc.), extracts emails via regex,
 * filters noise, and classifies each as "personal" or "generic".
 *
 * Uses the existing Jina reader (r.jina.ai) for fetching so it works
 * on JS-rendered pages and sites that block direct crawlers.
 *
 * Runs BEFORE Hunter in the cascade. If a personal email is found here,
 * Hunter is skipped entirely (saving $0.01/firm).
 */

import { fetchViaJina } from "../jinaFetcher";
import type { AgentSection, FieldResultMap } from "../agentScraper";

// ── CONFIG ──────────────────────────────────────────────────────────────────

const PATHS_TO_CHECK = [
  "/",
  "/contact",
  "/contact-us",
  "/contactus",
  "/about",
  "/about-us",
  "/aboutus",
  "/team",
  "/our-team",
  "/people",
  "/staff",
  "/support",
  "/get-in-touch",
  "/reach-us",
  "/connect",
  "/info",
  "/company",
  "/who-we-are",
];

const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

const NOISE_PREFIXES = new Set([
  "noreply", "no-reply", "donotreply", "do-not-reply", "mailer-daemon",
  "postmaster", "abuse", "webmaster", "example", "test", "user", "email",
  "your", "name", "username", "sentry", "wix", "wordpress", "jquery",
  "bootstrap", "cloudflare", "google", "facebook", "twitter", "github",
]);

const NOISE_DOMAINS = new Set([
  "example.com", "sentry.io", "wixpress.com", "wordpress.org", "jquery.com",
  "w3.org", "schema.org", "googleapis.com", "google.com", "facebook.com",
  "twitter.com", "github.com", "cloudflare.com", "gravatar.com", "wp.com",
  "yoursite.com", "yourdomain.com", "domain.com", "email.com", "test.com",
]);

const GENERIC_PREFIXES = new Set([
  "info", "contact", "hello", "admin", "office", "general", "support",
  "sales", "service", "customerservice", "help", "enquiries", "inquiries",
  "mail", "team", "feedback",
]);

const SKIP_EXT_REGEX = /\.(png|jpg|jpeg|gif|svg|css|js|webp|ico|pdf|zip|woff|ttf|eot)$/i;

// ── HELPERS ──────────────────────────────────────────────────────────────────

function cleanEmail(raw: string): string | null {
  const lower = raw.toLowerCase().replace(/\.$/, "");
  const atIdx = lower.indexOf("@");
  if (atIdx === -1) return null;
  const prefix = lower.slice(0, atIdx);
  const domain = lower.slice(atIdx + 1);
  if (!domain || !domain.includes(".")) return null;
  if (NOISE_DOMAINS.has(domain)) return null;
  if (NOISE_PREFIXES.has(prefix)) return null;
  if (SKIP_EXT_REGEX.test(lower)) return null;
  if (prefix.length > 40 || domain.length > 60) return null;
  if (/^\d+$/.test(prefix)) return null;
  return lower;
}

function classifyEmail(email: string): "personal" | "generic" {
  const prefix = email.split("@")[0];
  return GENERIC_PREFIXES.has(prefix) ? "generic" : "personal";
}

// ── TYPES ────────────────────────────────────────────────────────────────────

export interface ScrapedEmail {
  email: string;
  type: "personal" | "generic";
  sourcePath: string;
}

export interface DirectEmailScrapeResult {
  /** All unique emails found across all paths, sorted personal-first */
  emails: ScrapedEmail[];
  /** Best personal email found, if any */
  bestPersonal: ScrapedEmail | null;
  /** Best generic email found (fallback), if any */
  bestGeneric: ScrapedEmail | null;
  /** Number of paths successfully fetched */
  pathsChecked: number;
}

// ── MAIN ─────────────────────────────────────────────────────────────────────

/**
 * Scrape a domain for email addresses across 18 common paths.
 *
 * @param domain  Bare domain, e.g. "acme.com" (no protocol, no www)
 * @param maxPaths  Max paths to check (default: all 18). Reduce for speed.
 * @returns  All found emails, classified and sorted personal-first.
 */
export async function scrapeEmailsFromDomain(
  domain: string,
  maxPaths = PATHS_TO_CHECK.length,
): Promise<DirectEmailScrapeResult> {
  const found = new Map<string, ScrapedEmail>(); // email → ScrapedEmail
  let pathsChecked = 0;

  const pathsToRun = PATHS_TO_CHECK.slice(0, maxPaths);

  // Fetch all paths concurrently (Jina handles rate limiting internally)
  const results = await Promise.allSettled(
    pathsToRun.map(async (path) => {
      const url = `https://${domain}${path}`;
      const fetched = await fetchViaJina(url);
      return { path, content: fetched?.content ?? null };
    }),
  );

  for (const result of results) {
    if (result.status !== "fulfilled" || !result.value.content) continue;
    const { path, content } = result.value;
    pathsChecked++;

    const matches = content.match(EMAIL_REGEX) ?? [];
    for (const raw of matches) {
      const cleaned = cleanEmail(raw);
      if (cleaned && !found.has(cleaned)) {
        found.set(cleaned, {
          email: cleaned,
          type: classifyEmail(cleaned),
          sourcePath: path,
        });
      }
    }
  }

  // Sort: personal emails first, then generic
  const emails = Array.from(found.values()).sort((a, b) => {
    if (a.type === "personal" && b.type !== "personal") return -1;
    if (a.type !== "personal" && b.type === "personal") return 1;
    return 0;
  });

  const bestPersonal = emails.find(e => e.type === "personal") ?? null;
  const bestGeneric = emails.find(e => e.type === "generic") ?? null;

  console.log(
    `[directEmailScraper] ${domain}: checked ${pathsChecked}/${pathsToRun.length} paths, ` +
    `found ${emails.length} emails (${emails.filter(e => e.type === "personal").length} personal, ` +
    `${emails.filter(e => e.type === "generic").length} generic)`,
  );

  return { emails, bestPersonal, bestGeneric, pathsChecked };
}

// ── ENRICHMENT GATE ──────────────────────────────────────────────────────────

/**
 * Determines whether to run the direct email scraper.
 * Skips if all email-related fields are already confident.
 */
export function shouldRunDirectEmailScraper(
  sections: AgentSection[],
  fieldResults: FieldResultMap,
  confidenceThreshold: number,
): boolean {
  const emailFields = sections.filter(s =>
    /email/i.test(s.key + " " + s.label),
  );
  if (emailFields.length === 0) return false;

  // Skip if all email fields are already confident
  const allConfident = emailFields.every(
    s => (fieldResults[s.key]?.confidence ?? 0) >= confidenceThreshold,
  );
  return !allConfident;
}
