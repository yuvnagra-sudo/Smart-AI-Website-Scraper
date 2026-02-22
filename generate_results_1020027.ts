/**
 * Server-side script to generate Excel export for job 1020027
 * Runs directly on the server without requiring authentication
 */

import { generateResultsFile } from './server/generateResultsService';
import { storagePut } from './server/storage';

async function main() {
  const jobId = 1020028;
  
  console.log(`Generating Excel export for job ${jobId}...`);
  console.log(`This will export 1,532 completed firms without affecting the running job.\n`);
  
  try {
    const result = await generateResultsFile({ jobId });
    
    console.log('✅ Excel file generated successfully!');
    console.log(`Firms: ${result.firmCount}`);
    console.log(`Team Members: ${result.teamMemberCount}`);
    console.log(`File Name: ${result.fileName}`);
    console.log(`File Size: ${(result.fileBuffer.length / 1024 / 1024).toFixed(2)} MB\n`);
    
    // Upload to S3
    console.log('Uploading to S3...');
    const uploadResult = await storagePut(
      `enrichment-results/${result.fileName}`,
      result.fileBuffer,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    
    console.log('✅ Upload completed!');
    console.log(`Download URL: ${uploadResult.url}`);
    console.log(`\nThe Excel file is ready for download.`);
    
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

main();
