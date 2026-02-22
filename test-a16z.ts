/**
 * Manual test script for a16z team extraction
 * Tests the actual scraping and LLM extraction to see what's happening
 */

import { scrapeWebsite } from './server/scraper';
import { extractTeamMembersComprehensive } from './server/comprehensiveTeamExtraction';
import { classifyDecisionMakerTier } from './server/decisionMakerTiers';

async function testA16z() {
  console.log('========================================');
  console.log('Testing Andreessen Horowitz (a16z) Team Extraction');
  console.log('========================================\n');

  const url = 'https://a16z.com/team';
  const companyName = 'Andreessen Horowitz';

  // Step 1: Scrape the website
  console.log(`Step 1: Scraping ${url}...`);
  const result = await scrapeWebsite({
    url,
    cache: false, // Don't use cache for testing
    timeout: 10000,
  });

  if (!result.success || !result.html) {
    console.error('✗ Failed to scrape website');
    console.error('Error:', result.error);
    return;
  }

  console.log(`✓ Successfully scraped ${result.html.length} characters`);
  console.log(`Strategy used: ${result.strategy}`);
  console.log(`Time taken: ${result.timeTaken}ms\n`);

  // Save HTML to file for inspection
  const fs = await import('fs');
  const htmlPath = '/home/ubuntu/a16z-team-page.html';
  fs.writeFileSync(htmlPath, result.html);
  console.log(`✓ Saved HTML to ${htmlPath}\n`);

  // Step 2: Extract text content
  const cheerio = await import('cheerio');
  const $ = cheerio.load(result.html);
  $('script, style, nav, footer, header').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  console.log(`Step 2: Extracted ${text.length} characters of text`);
  console.log(`First 500 chars: ${text.substring(0, 500)}...\n`);

  // Step 3: Extract team members using LLM
  console.log('Step 3: Extracting team members with LLM...');
  const members = await extractTeamMembersComprehensive(
    result.html,
    companyName,
    (msg) => console.log(`  [Progress] ${msg}`)
  );

  console.log(`\n✓ Extracted ${members.length} team members\n`);

  // Step 4: Show sample members and tier classification
  if (members.length > 0) {
    console.log('Sample team members (first 10):');
    members.slice(0, 10).forEach((member, idx) => {
      const tier = classifyDecisionMakerTier(member.title);
      console.log(`  ${idx + 1}. ${member.name}`);
      console.log(`     Title: "${member.title}"`);
      console.log(`     Function: "${member.job_function}"`);
      console.log(`     Tier: ${tier.tier} (${tier.description})`);
      console.log(`     Priority: ${tier.priority}`);
      console.log('');
    });
  } else {
    console.log('✗ No team members extracted!');
    console.log('\nPossible reasons:');
    console.log('1. LLM failed to parse the HTML structure');
    console.log('2. Team page uses JavaScript rendering that Puppeteer didn\'t capture');
    console.log('3. HTML structure is too complex or unusual');
    console.log('\nCheck the saved HTML file to see what was actually scraped.');
  }

  // Step 5: Count by tier
  console.log('\n========================================');
  console.log('Tier Distribution:');
  const tierCounts: Record<string, number> = {};
  members.forEach(member => {
    const tier = classifyDecisionMakerTier(member.title).tier;
    tierCounts[tier] = (tierCounts[tier] || 0) + 1;
  });
  Object.entries(tierCounts).forEach(([tier, count]) => {
    console.log(`  ${tier}: ${count} members`);
  });
  console.log('========================================\n');
}

testA16z().catch(console.error);
