import { getDb } from './server/db';
import { enrichmentJobs } from './drizzle/schema';
import { eq } from 'drizzle-orm';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';

async function startTestJob() {
  console.log('📊 Starting Phase 1 Test Job...\n');

  // Read test CSV
  const csvPath = '/home/ubuntu/test_20_firms.csv';
  const csvContent = fs.readFileSync(csvPath, 'utf-8');
  
  // Parse CSV
  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
  });

  console.log(`✅ Loaded ${records.length} firms from CSV\n`);

  // Create enrichment job
  const db = await getDb();
  if (!db) {
    throw new Error('Database not available');
  }
  
  const result = await db.insert(enrichmentJobs).values({
    userId: 1, // Test user ID
    status: 'pending',
    inputFileUrl: '/home/ubuntu/test_20_firms.csv',
    inputFileKey: 'test_20_firms.csv',
    inputData: JSON.stringify(records),
    firmCount: records.length,
    processedCount: 0,
    tierFilter: 'all',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  
  const jobId = Number(result[0].insertId);
  const [job] = await db.select().from(enrichmentJobs).where(eq(enrichmentJobs.id, jobId));

  console.log(`✅ Created job ${job.id}\n`);
  console.log(`📋 Job Details:`);
  console.log(`   - ID: ${job.id}`);
  console.log(`   - Status: ${job.status}`);
  console.log(`   - Firm Count: ${job.firmCount}`);
  console.log(`   - Tier Filter: ${job.tierFilter}`);
  console.log(`\n🚀 Job created! The worker will pick it up automatically.`);
  console.log(`\n📊 Monitor progress with:`);
  console.log(`   SELECT * FROM enrichmentJobs WHERE id = ${job.id};`);
  console.log(`   SELECT COUNT(*) FROM enrichedFirms WHERE jobId = ${job.id};`);
  console.log(`   SELECT COUNT(*) FROM teamMembers WHERE jobId = ${job.id};`);
  console.log(`   SELECT * FROM processedFirms WHERE jobId = ${job.id} ORDER BY processedAt DESC LIMIT 5;`);

  return job.id;
}

startTestJob()
  .then((jobId) => {
    console.log(`\n✅ Test job ${jobId} started successfully!`);
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Error starting test job:', error);
    process.exit(1);
  });
