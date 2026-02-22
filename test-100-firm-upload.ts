/**
 * Programmatic test: Upload 100-firm file and monitor LLM queue
 */

import { readFileSync } from 'fs';
import { parseInputExcel } from './server/excelProcessor';
import { createEnrichmentJob } from './server/enrichmentDb';
import { getLLMQueueStats } from './server/_core/llmQueue';

async function test100FirmUpload() {
  console.log('\n' + '='.repeat(60));
  console.log('100-FIRM LLM QUEUE TEST');
  console.log('='.repeat(60) + '\n');
  
  // Read test file
  const filePath = '/home/ubuntu/100-firm-test.xlsx';
  console.log(`📁 Reading test file: ${filePath}`);
  
  const fileBuffer = readFileSync(filePath);
  console.log(`✅ File loaded: ${fileBuffer.length} bytes\n`);
  
  // Parse Excel
  console.log('📊 Parsing Excel file...');
  // Upload to temporary location for parsing
  const { storagePut } = await import('./server/storage');
  const testKey = `test/100-firm-test-${Date.now()}.xlsx`;
  const { url: fileUrl } = await storagePut(testKey, fileBuffer, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  console.log(`✅ Uploaded to: ${fileUrl}`);
  
  const firms = await parseInputExcel(fileUrl);
  console.log(`✅ Parsed ${firms.length} firms\n`);
  
  // Sample firms
  console.log('Sample firms:');
  firms.slice(0, 5).forEach((firm, i) => {
    console.log(`  ${i + 1}. ${firm.companyName} - ${firm.websiteUrl}`);
  });
  console.log('  ...\n');
  
  // Create enrichment job
  console.log('🚀 Creating enrichment job...');
  const job = await createEnrichmentJob({
    userId: 1, // Test user
    firmCount: firms.length,
    inputFileUrl: fileUrl,
    inputFileKey: testKey,
    tierFilter: 'tier1-2',
  });
  
  console.log(`✅ Job created: ID ${job.id}\n`);
  
  console.log('📊 Initial LLM Queue Stats:');
  const initialStats = getLLMQueueStats();
  console.log(JSON.stringify(initialStats, null, 2));
  console.log('');
  
  console.log('🔄 Job will be picked up by worker automatically');
  console.log('📝 Monitor progress with:');
  console.log(`   pm2 logs vc-enrichment-worker --lines 50`);
  console.log('');
  console.log('📊 Check queue stats with:');
  console.log(`   curl http://localhost:3000/api/queue-stats`);
  console.log('');
  console.log('✅ Test setup complete! Worker will process the job.');
  console.log('='.repeat(60) + '\n');
}

test100FirmUpload().catch(error => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});
