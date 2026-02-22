/**
 * Generate a realistic 100-firm test Excel file
 */

import ExcelJS from 'exceljs';
import { writeFileSync } from 'fs';

// Real VC firms with websites
const testFirms = [
  { name: "Sequoia Capital", website: "https://www.sequoiacap.com", description: "Leading venture capital firm" },
  { name: "Andreessen Horowitz", website: "https://a16z.com", description: "Technology-focused VC firm" },
  { name: "Accel", website: "https://www.accel.com", description: "Early and growth stage investments" },
  { name: "Benchmark", website: "https://www.benchmark.com", description: "Early-stage venture capital" },
  { name: "Greylock Partners", website: "https://greylock.com", description: "Enterprise and consumer technology" },
  { name: "Kleiner Perkins", website: "https://www.kleinerperkins.com", description: "Venture capital pioneer" },
  { name: "Lightspeed Venture Partners", website: "https://lsvp.com", description: "Multi-stage venture capital" },
  { name: "NEA", website: "https://www.nea.com", description: "New Enterprise Associates" },
  { name: "General Catalyst", website: "https://www.generalcatalyst.com", description: "Seed to growth stage" },
  { name: "Insight Partners", website: "https://www.insightpartners.com", description: "Software and internet" },
  
  // Add more firms to reach 100
  { name: "Tiger Global Management", website: "https://www.tigerglobal.com", description: "Technology investments" },
  { name: "Founders Fund", website: "https://foundersfund.com", description: "Technology venture capital" },
  { name: "Index Ventures", website: "https://www.indexventures.com", description: "European and US technology" },
  { name: "GGV Capital", website: "https://www.ggvc.com", description: "US and Asia expansion" },
  { name: "Battery Ventures", website: "https://www.battery.com", description: "Technology and industrial" },
  { name: "Bessemer Venture Partners", website: "https://www.bvp.com", description: "Multi-stage venture capital" },
  { name: "Khosla Ventures", website: "https://www.khoslaventures.com", description: "Technology and cleantech" },
  { name: "Spark Capital", website: "https://www.sparkcapital.com", description: "Consumer and enterprise" },
  { name: "Union Square Ventures", website: "https://www.usv.com", description: "Network-based businesses" },
  { name: "First Round Capital", website: "https://firstround.com", description: "Seed-stage venture capital" },
  
  { name: "Redpoint Ventures", website: "https://www.redpoint.com", description: "Seed to growth stage" },
  { name: "Mayfield Fund", website: "https://www.mayfield.com", description: "Early-stage technology" },
  { name: "Matrix Partners", website: "https://www.matrixpartners.com", description: "Seed and early stage" },
  { name: "Canaan Partners", website: "https://www.canaan.com", description: "Early and growth stage" },
  { name: "Norwest Venture Partners", website: "https://www.nvp.com", description: "Multi-stage investment" },
  { name: "Menlo Ventures", website: "https://www.menlovc.com", description: "Technology venture capital" },
  { name: "Initialized Capital", website: "https://initialized.com", description: "Seed-stage investments" },
  { name: "Cowboy Ventures", website: "https://www.cowboy.vc", description: "Seed-stage technology" },
  { name: "Lux Capital", website: "https://www.luxcapital.com", description: "Science and technology" },
  { name: "8VC", website: "https://8vc.com", description: "Technology and healthcare" },
  
  { name: "Felicis Ventures", website: "https://www.felicis.com", description: "Seed and early stage" },
  { name: "CRV", website: "https://www.crv.com", description: "Charles River Ventures" },
  { name: "Upfront Ventures", website: "https://www.upfront.com", description: "LA-based venture capital" },
  { name: "True Ventures", website: "https://trueventures.com", description: "Early-stage technology" },
  { name: "Freestyle Capital", website: "https://freestyle.vc", description: "Seed-stage investments" },
  { name: "Emergence Capital", website: "https://www.emcap.com", description: "Enterprise SaaS" },
  { name: "Scale Venture Partners", website: "https://www.scalevp.com", description: "Growth-stage technology" },
  { name: "Storm Ventures", website: "https://www.stormventures.com", description: "Enterprise software" },
  { name: "Work-Bench", website: "https://www.work-bench.com", description: "Enterprise technology" },
  { name: "Amplify Partners", website: "https://amplifypartners.com", description: "Infrastructure and data" },
  
  { name: "Wing VC", website: "https://wing.vc", description: "Early-stage technology" },
  { name: "Costanoa Ventures", website: "https://www.costanoavc.com", description: "Enterprise technology" },
  { name: "Susa Ventures", website: "https://www.susaventures.com", description: "Seed-stage investments" },
  { name: "Homebrew", website: "https://homebrew.co", description: "Seed-stage venture capital" },
  { name: "Boldstart Ventures", website: "https://boldstart.vc", description: "Enterprise infrastructure" },
  { name: "Point72 Ventures", website: "https://www.point72ventures.com", description: "Early-stage technology" },
  { name: "Unusual Ventures", website: "https://www.unusual.vc", description: "Seed-stage investments" },
  { name: "Gradient Ventures", website: "https://www.gradient.com", description: "AI-focused venture capital" },
  { name: "Data Collective", website: "https://www.dcvc.com", description: "Deep tech investments" },
  { name: "Sutter Hill Ventures", website: "https://www.shv.com", description: "Technology venture capital" },
  
  // Continue with more firms
  { name: "Venrock", website: "https://www.venrock.com", description: "Healthcare and technology" },
  { name: "New Enterprise Associates", website: "https://www.nea.com", description: "Multi-stage venture capital" },
  { name: "Draper Fisher Jurvetson", website: "https://dfj.com", description: "Technology investments" },
  { name: "Polaris Partners", website: "https://www.polarispartners.com", description: "Healthcare and technology" },
  { name: "Highland Capital Partners", website: "https://www.hcp.com", description: "Technology and healthcare" },
  { name: "Sigma Partners", website: "https://www.sigmapartners.com", description: "Early-stage technology" },
  { name: "North Bridge Venture Partners", website: "https://www.nbvp.com", description: "Enterprise technology" },
  { name: "OpenView Venture Partners", website: "https://www.openviewpartners.com", description: "Expansion stage SaaS" },
  { name: "Summit Partners", website: "https://www.summitpartners.com", description: "Growth equity" },
  { name: "TA Associates", website: "https://www.ta.com", description: "Private equity and growth" },
  
  { name: "Warburg Pincus", website: "https://www.warburgpincus.com", description: "Global private equity" },
  { name: "Silver Lake", website: "https://www.silverlake.com", description: "Technology investments" },
  { name: "Thoma Bravo", website: "https://www.thomabravo.com", description: "Software private equity" },
  { name: "Vista Equity Partners", website: "https://www.vistaequitypartners.com", description: "Enterprise software" },
  { name: "Francisco Partners", website: "https://www.franciscopartners.com", description: "Technology buyouts" },
  { name: "Bain Capital Ventures", website: "https://www.baincapitalventures.com", description: "Seed to growth stage" },
  { name: "Sapphire Ventures", website: "https://sapphireventures.com", description: "Growth-stage technology" },
  { name: "Meritech Capital", website: "https://www.meritechcapital.com", description: "Late-stage technology" },
  { name: "IVP", website: "https://www.ivp.com", description: "Institutional Venture Partners" },
  { name: "Technology Crossover Ventures", website: "https://www.tcv.com", description: "Growth equity" },
  
  { name: "Accel-KKR", website: "https://www.accel-kkr.com", description: "Software private equity" },
  { name: "Spectrum Equity", website: "https://www.spectrumequity.com", description: "Growth equity" },
  { name: "Great Hill Partners", website: "https://www.greathillpartners.com", description: "Growth equity" },
  { name: "Vector Capital", website: "https://www.vectorcapital.com", description: "Technology private equity" },
  { name: "Riverside Company", website: "https://www.riversidecompany.com", description: "Private equity" },
  { name: "Parthenon Capital", website: "https://www.parthenoncapital.com", description: "Growth equity" },
  { name: "Marlin Equity Partners", website: "https://www.marlinequity.com", description: "Technology investments" },
  { name: "Clearlake Capital", website: "https://www.clearlakecapital.com", description: "Private equity" },
  { name: "Insight Venture Partners", website: "https://www.insightpartners.com", description: "Software growth equity" },
  { name: "Riverwood Capital", website: "https://www.riverwoodcapital.com", description: "Technology growth equity" },
  
  { name: "Stripes", website: "https://stripes.com", description: "Growth equity" },
  { name: "Coatue Management", website: "https://www.coatue.com", description: "Technology investments" },
  { name: "DST Global", website: "https://dst-global.com", description: "Late-stage technology" },
  { name: "SoftBank Vision Fund", website: "https://visionfund.com", description: "Technology investments" },
  { name: "Dragoneer Investment Group", website: "https://www.dragoneer.com", description: "Growth equity" },
  { name: "Altimeter Capital", website: "https://www.altimeter.com", description: "Technology investments" },
  { name: "Durable Capital Partners", website: "https://www.durablecapital.com", description: "Growth equity" },
  { name: "Whale Rock Capital", website: "https://www.whalerockcapital.com", description: "Technology investments" },
  { name: "Lone Pine Capital", website: "https://www.lonepinecapital.com", description: "Technology investments" },
  { name: "Greenoaks Capital", website: "https://www.greenoakscap.com", description: "Growth equity" },
  
  { name: "Baillie Gifford", website: "https://www.bailliegifford.com", description: "Long-term investors" },
  { name: "Fidelity Investments", website: "https://www.fidelity.com", description: "Growth investments" },
  { name: "T. Rowe Price", website: "https://www.troweprice.com", description: "Growth equity" },
  { name: "Wellington Management", website: "https://www.wellington.com", description: "Investment management" },
  { name: "BlackRock", website: "https://www.blackrock.com", description: "Asset management" },
  { name: "Vanguard", website: "https://www.vanguard.com", description: "Investment management" },
  { name: "Capital Group", website: "https://www.capitalgroup.com", description: "Investment management" },
  { name: "Franklin Templeton", website: "https://www.franklintempleton.com", description: "Investment management" },
  { name: "AllianceBernstein", website: "https://www.alliancebernstein.com", description: "Investment management" },
  { name: "Invesco", website: "https://www.invesco.com", description: "Investment management" },
];

async function generateTestFile() {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('VC Firms');
  
  // Add headers
  worksheet.columns = [
    { header: 'Company Name', key: 'companyName', width: 30 },
    { header: 'Website URL', key: 'websiteUrl', width: 40 },
    { header: 'Description', key: 'description', width: 50 },
  ];
  
  // Add firms
  testFirms.forEach(firm => {
    worksheet.addRow({
      companyName: firm.name,
      websiteUrl: firm.website,
      description: firm.description,
    });
  });
  
  // Save file
  const buffer = await workbook.xlsx.writeBuffer();
  writeFileSync('/home/ubuntu/100-firm-test.xlsx', buffer);
  
  console.log(`✅ Generated test file with ${testFirms.length} firms`);
  console.log(`📁 File saved to: /home/ubuntu/100-firm-test.xlsx`);
}

generateTestFile().catch(console.error);
