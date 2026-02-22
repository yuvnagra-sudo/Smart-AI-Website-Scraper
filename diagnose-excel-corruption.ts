import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import * as schema from './drizzle/schema';

const connection = await mysql.createConnection(process.env.DATABASE_URL!);
const db = drizzle(connection, { schema, mode: 'default' });
import axios from 'axios';
import * as XLSX from 'xlsx';
import * as fs from 'fs';

async function main() {
  
  // Get the most recent completed job
  const [job] = await db.execute(
    'SELECT * FROM enrichmentJobs WHERE status = "completed" ORDER BY id DESC LIMIT 1'
  );
  
  if (!job || (job as any[]).length === 0) {
    console.log('No completed jobs found');
    return;
  }
  
  const jobData = (job as any[])[0];
  console.log(`\n=== Analyzing Job ${jobData.id} ===`);
  console.log(`Total Firms: ${jobData.totalCount}`);
  console.log(`Processed: ${jobData.processedCount}`);
  console.log(`Output URL: ${jobData.outputFileUrl}`);
  
  // Download the Excel file
  console.log('\nDownloading Excel file...');
  const response = await axios.get(jobData.outputFileUrl, {
    responseType: 'arraybuffer',
    timeout: 30000,
  });
  
  const buffer = Buffer.from(response.data);
  console.log(`Downloaded ${buffer.length} bytes`);
  
  // Save to local file for inspection
  const localPath = '/home/ubuntu/test-output.xlsx';
  fs.writeFileSync(localPath, buffer);
  console.log(`Saved to ${localPath}`);
  
  // Try to parse with XLSX
  console.log('\nAttempting to parse Excel file...');
  try {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    console.log(`✓ Excel file is valid`);
    console.log(`Sheets: ${workbook.SheetNames.join(', ')}`);
    
    // Analyze each sheet
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(sheet);
      console.log(`\n${sheetName}: ${data.length} rows`);
      
      if (data.length > 0) {
        const firstRow = data[0] as any;
        console.log(`  Columns: ${Object.keys(firstRow).join(', ')}`);
        
        // Check for problematic data
        for (const row of data.slice(0, 5)) {
          const r = row as any;
          for (const [key, value] of Object.entries(r)) {
            if (typeof value === 'string' && value.length > 1000) {
              console.log(`  ⚠ Long value in ${key}: ${value.length} chars`);
            }
            if (typeof value === 'object') {
              console.log(`  ⚠ Object value in ${key}: ${JSON.stringify(value).substring(0, 100)}`);
            }
          }
        }
      }
    }
  } catch (error) {
    console.error(`✗ Excel parsing failed:`, error);
  }
}

main().catch(console.error);
