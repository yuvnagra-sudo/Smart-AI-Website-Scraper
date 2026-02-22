/**
 * Test portfolio extraction on the 10 problem firms
 */
import { VCEnrichmentService } from '../server/vcEnrichment.js';

const problemFirms = [
  { name: '01 Advisors', url: 'https://01a.com', expectedCount: 27 },
  { name: '10H Capital', url: 'https://10hcapital.com', expectedCount: 15 },
  { name: '11 Ventures', url: 'https://11.vc', expectedCount: 5 },
  { name: 'Primordial Ventures', url: 'https://primordialventures.com', expectedCount: 10 },
  { name: '100.partners', url: 'https://100.partners', expectedCount: 5 },
  { name: '1004 Venture Partners', url: 'https://1004venturepartners.com', expectedCount: 5 },
  { name: '100KM', url: 'https://100km.com', expectedCount: 5 },
  { name: '1080 Ventures', url: 'https://1080ventures.com', expectedCount: 5 },
  { name: '10mk', url: 'https://10mk.com', expectedCount: 5 },
  { name: '10X Impact', url: 'https://10ximpact.com', expectedCount: 5 },
];

console.log('='.repeat(80));
console.log('PORTFOLIO EXTRACTION TEST');
console.log('Testing 10 problem firms identified in manual review');
console.log('='.repeat(80));
console.log('');

const service = new VCEnrichmentService();
const results = [];

for (const firm of problemFirms) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`Testing: ${firm.name}`);
  console.log(`URL: ${firm.url}`);
  console.log(`Expected: ~${firm.expectedCount} portfolio companies`);
  console.log(`${'='.repeat(80)}\n`);
  
  try {
    const startTime = Date.now();
    const portfolioCompanies = await service.extractPortfolioCompanies(firm.url, firm.name);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    console.log(`\n✓ Extraction complete in ${duration}s`);
    console.log(`Found: ${portfolioCompanies.length} portfolio companies`);
    
    if (portfolioCompanies.length > 0) {
      console.log('\nSample companies:');
      portfolioCompanies.slice(0, 5).forEach((company, idx) => {
        console.log(`  ${idx + 1}. ${company.companyName}`);
        console.log(`     Website: ${company.websiteUrl || 'N/A'}`);
        console.log(`     Stage: ${company.investmentStage || 'Unknown'}`);
        console.log(`     Sector: ${company.sector || 'Unknown'}`);
        console.log(`     Method: ${company.extractionMethod || 'N/A'}`);
      });
      
      if (portfolioCompanies.length > 5) {
        console.log(`  ... and ${portfolioCompanies.length - 5} more`);
      }
    }
    
    results.push({
      firm: firm.name,
      expected: firm.expectedCount,
      found: portfolioCompanies.length,
      success: portfolioCompanies.length >= Math.floor(firm.expectedCount * 0.7), // 70% threshold
      duration: duration,
      method: portfolioCompanies[0]?.extractionMethod || 'N/A'
    });
    
  } catch (error) {
    console.error(`\n✗ Error extracting portfolio for ${firm.name}:`, error.message);
    results.push({
      firm: firm.name,
      expected: firm.expectedCount,
      found: 0,
      success: false,
      duration: 0,
      method: 'ERROR',
      error: error.message
    });
  }
  
  // Wait 2 seconds between firms to avoid rate limiting
  await new Promise(resolve => setTimeout(resolve, 2000));
}

// Print summary
console.log(`\n\n${'='.repeat(80)}`);
console.log('TEST SUMMARY');
console.log(`${'='.repeat(80)}\n`);

console.log('Firm                          | Expected | Found | Success | Method');
console.log('-'.repeat(80));

results.forEach(r => {
  const firmName = r.firm.padEnd(28);
  const expected = String(r.expected).padStart(8);
  const found = String(r.found).padStart(5);
  const success = (r.success ? '✓' : '✗').padStart(7);
  const method = (r.method || 'N/A').padEnd(15);
  console.log(`${firmName} | ${expected} | ${found} | ${success} | ${method}`);
});

const successCount = results.filter(r => r.success).length;
const totalCount = results.length;
const successRate = ((successCount / totalCount) * 100).toFixed(1);

console.log('\n' + '='.repeat(80));
console.log(`Overall Success Rate: ${successCount}/${totalCount} (${successRate}%)`);
console.log('='.repeat(80));

process.exit(0);
