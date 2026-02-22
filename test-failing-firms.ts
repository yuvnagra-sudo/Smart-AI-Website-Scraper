/**
 * Test script for firms returning 0 team members
 * Tests: a16z, Conscience VC, Bessemer Venture Partners
 */

import { VCEnrichmentService } from './server/vcEnrichment';

const firms = [
  {
    name: 'Andreessen Horowitz',
    website: 'https://a16z.com',
    description: 'Venture capital firm investing in technology companies'
  },
  {
    name: 'Conscience VC',
    website: 'https://consciencevc.com',
    description: 'Venture capital firm focused on impact investing'
  },
  {
    name: 'Bessemer Venture Partners',
    website: 'https://www.bvp.com',
    description: 'Global venture capital firm'
  }
];

async function testFirm(name: string, website: string, description: string) {
  console.log('\n========================================');
  console.log(`Testing: ${name}`);
  console.log(`Website: ${website}`);
  console.log('========================================\n');

  const service = new VCEnrichmentService();

  try {
    const result = await service.enrichVCFirm(
      name,
      website,
      description,
      (msg) => console.log(`[Progress] ${msg}`)
    );

    console.log('\n--- RESULTS ---');
    console.log(`Team Members: ${result.teamMembers.length}`);
    console.log(`Portfolio Companies: ${result.portfolioCompanies.length}`);
    console.log(`Investment Niches: ${result.investmentNiches.join(', ')}`);
    
    if (result.teamMembers.length > 0) {
      console.log('\nSample Team Members (first 5):');
      result.teamMembers.slice(0, 5).forEach((m, idx) => {
        console.log(`  ${idx + 1}. ${m.name} - "${m.title}"`);
      });
    } else {
      console.log('\n⚠️  NO TEAM MEMBERS FOUND!');
    }

  } catch (error) {
    console.error('\n❌ ERROR:', error);
  }
}

async function runTests() {
  for (const firm of firms) {
    await testFirm(firm.name, firm.website, firm.description);
    
    // Wait between tests
    console.log('\nWaiting 5 seconds before next test...\n');
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  
  console.log('\n========================================');
  console.log('All tests complete!');
  console.log('========================================\n');
  
  process.exit(0);
}

runTests().catch(console.error);
