import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import * as schema from './drizzle/schema';
import axios from 'axios';
import * as XLSX from 'xlsx';

const connection = await mysql.createConnection(process.env.DATABASE_URL!);
const db = drizzle(connection, { schema, mode: 'default' });

async function main() {
  // Get a completed job
  const [job] = await db.execute(
    'SELECT * FROM enrichmentJobs WHERE status = "completed" ORDER BY id DESC LIMIT 1'
  );
  
  if (!job || (job as any[]).length === 0) {
    console.log('No large completed jobs found');
    return;
  }
  
  const jobData = (job as any[])[0];
  console.log(`\n=== Analyzing Job ${jobData.id} ===`);
  console.log(`Total Firms: ${jobData.totalCount}`);
  console.log(`Processed: ${jobData.processedCount}`);
  console.log(`Tier Filter: ${jobData.tierFilter || 'all'}`);
  
  // Download and parse Excel
  const response = await axios.get(jobData.outputFileUrl, {
    responseType: 'arraybuffer',
    timeout: 30000,
  });
  
  const buffer = Buffer.from(response.data);
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  
  // Analyze each sheet
  const firmsSheet = XLSX.utils.sheet_to_json(workbook.Sheets['VC Firms']);
  const teamSheet = XLSX.utils.sheet_to_json(workbook.Sheets['Team Members']);
  const portfolioSheet = XLSX.utils.sheet_to_json(workbook.Sheets['Portfolio Companies']);
  
  console.log(`\n=== Excel Content ===`);
  console.log(`VC Firms: ${firmsSheet.length} rows`);
  console.log(`Team Members: ${teamSheet.length} rows`);
  console.log(`Portfolio Companies: ${portfolioSheet.length} rows`);
  
  // Check for missing data
  const firmsWithNoTeam = firmsSheet.filter((f: any) => {
    const firmName = f.companyName;
    return !teamSheet.some((t: any) => t.vcFirm === firmName);
  });
  
  const firmsWithNoPortfolio = firmsSheet.filter((f: any) => {
    const firmName = f.companyName;
    return !portfolioSheet.some((p: any) => p.vcFirm === firmName);
  });
  
  console.log(`\n=== Data Completeness ===`);
  console.log(`Firms with NO team members: ${firmsWithNoTeam.length}`);
  if (firmsWithNoTeam.length > 0 && firmsWithNoTeam.length < 10) {
    firmsWithNoTeam.forEach((f: any) => console.log(`  - ${f.companyName}`));
  }
  
  console.log(`Firms with NO portfolio companies: ${firmsWithNoPortfolio.length}`);
  if (firmsWithNoPortfolio.length > 0 && firmsWithNoPortfolio.length < 10) {
    firmsWithNoPortfolio.forEach((f: any) => console.log(`  - ${f.companyName}`));
  }
  
  // Check for empty/missing fields
  const firmsWithEmptyFields = firmsSheet.filter((f: any) => {
    return !f.investmentNiches || f.investmentNiches === '' || 
           !f.investorType || f.investorType === '' ||
           !f.investmentStages || f.investmentStages === '';
  });
  
  console.log(`\nFirms with empty critical fields: ${firmsWithEmptyFields.length}`);
  if (firmsWithEmptyFields.length > 0 && firmsWithEmptyFields.length < 10) {
    firmsWithEmptyFields.forEach((f: any) => {
      console.log(`  - ${f.companyName}:`);
      if (!f.investmentNiches || f.investmentNiches === '') console.log(`    Missing: investmentNiches`);
      if (!f.investorType || f.investorType === '') console.log(`    Missing: investorType`);
      if (!f.investmentStages || f.investmentStages === '') console.log(`    Missing: investmentStages`);
    });
  }
  
  // Sample a few firms to show what data looks like
  console.log(`\n=== Sample Data (First 3 Firms) ===`);
  firmsSheet.slice(0, 3).forEach((f: any) => {
    console.log(`\n${f.companyName}:`);
    console.log(`  Website: ${f.websiteUrl}`);
    console.log(`  Verified: ${f.websiteVerified}`);
    console.log(`  Investor Type: ${f.investorType}`);
    console.log(`  Stages: ${f.investmentStages}`);
    console.log(`  Niches: ${f.investmentNiches?.substring(0, 100)}${f.investmentNiches?.length > 100 ? '...' : ''}`);
    
    const teamCount = teamSheet.filter((t: any) => t.vcFirm === f.companyName).length;
    const portfolioCount = portfolioSheet.filter((p: any) => p.vcFirm === f.companyName).length;
    console.log(`  Team Members: ${teamCount}`);
    console.log(`  Portfolio Companies: ${portfolioCount}`);
  });
  
  await connection.end();
}

main().catch(console.error);
