import { getDb } from './server/db';
import { enrichmentJobs, enrichedFirms, teamMembers, processedFirms } from './drizzle/schema';
import { eq, desc } from 'drizzle-orm';

async function monitorJob(jobId: number) {
  const db = await getDb();
  if (!db) {
    throw new Error('Database not available');
  }

  // Get job status
  const [job] = await db.select().from(enrichmentJobs).where(eq(enrichmentJobs.id, jobId));
  
  if (!job) {
    console.log(`❌ Job ${jobId} not found`);
    return;
  }

  // Count enriched firms
  const firmsResult = await db.select({ count: enrichedFirms.id }).from(enrichedFirms).where(eq(enrichedFirms.jobId, jobId));
  const firmsCount = firmsResult.length;

  // Count team members
  const membersResult = await db.select({ count: teamMembers.id }).from(teamMembers).where(eq(teamMembers.jobId, jobId));
  const membersCount = membersResult.length;

  // Get recent processed firms
  const recentProcessed = await db.select()
    .from(processedFirms)
    .where(eq(processedFirms.jobId, jobId))
    .orderBy(desc(processedFirms.processedAt))
    .limit(5);

  console.log(`\n📊 Job ${jobId} Status Report`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Status: ${job.status}`);
  console.log(`Progress: ${job.processedCount}/${job.firmCount} firms`);
  console.log(`Current Firm: ${job.currentFirmName || 'N/A'}`);
  console.log(`Worker PID: ${job.workerPid || 'Not assigned'}`);
  console.log(`Started At: ${job.startedAt || 'Not started'}`);
  console.log(`\n📈 Data Saved:`);
  console.log(`  - Enriched Firms: ${firmsCount}`);
  console.log(`  - Team Members: ${membersCount}`);
  
  if (recentProcessed.length > 0) {
    console.log(`\n✅ Recently Processed Firms:`);
    recentProcessed.forEach((pf, i) => {
      console.log(`  ${i + 1}. ${pf.firmName} (${new Date(pf.processedAt).toLocaleTimeString()})`);
    });
  }
  
  console.log(`\n${'='.repeat(60)}\n`);
}

const jobId = parseInt(process.argv[2] || '1050002');
monitorJob(jobId)
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
  });
