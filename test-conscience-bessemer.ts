/**
 * Test Conscience VC and Bessemer Venture Partners
 */

import { VCEnrichmentService } from './server/vcEnrichment';

const firms = [
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
      console.log('\nTier Distribution:');
      const tier1 = result.teamMembers.filter(m => m.tier === 'Tier 1').length;
      const tier2 = result.teamMembers.filter(m => m.tier === 'Tier 2').length;
      const tier3 = result.teamMembers.filter(m => m.tier === 'Tier 3').length;
      const exclude = result.teamMembers.filter(m => m.tier === 'Exclude').length;
      console.log(`  Tier 1: ${tier1}`);
      console.log(`  Tier 2: ${tier2}`);
      console.log(`  Tier 3: ${tier3}`);
      console.log(`  Exclude: ${exclude}`);
      
      console.log('\nSample Team Members (first 10):');
      result.teamMembers.slice(0, 10).forEach((m, idx) => {
        console.log(`  ${idx + 1}. ${m.name} - "${m.title}" - ${m.tier}`);
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
    if (firms.indexOf(firm) < firms.length - 1) {
      console.log('\nWaiting 5 seconds before next test...\n');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  
  console.log('\n========================================');
  console.log('All tests complete!');
  console.log('========================================\n');
  
  process.exit(0);
}

runTests().catch(console.error);
