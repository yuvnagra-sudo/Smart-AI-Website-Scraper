import { getDb } from './server/db';
import { enrichmentJobs } from './drizzle/schema';
import { eq } from 'drizzle-orm';

async function resetJob(jobId: number) {
  const db = await getDb();
  if (!db) {
    throw new Error('Database not available');
  }
  
  await db.update(enrichmentJobs).set({
    status: 'pending',
    workerPid: null,
    heartbeatAt: null,
    startedAt: null,
    errorMessage: null,
  }).where(eq(enrichmentJobs.id, jobId));
  
  console.log(`✅ Job ${jobId} reset to pending status`);
}

const jobId = parseInt(process.argv[2] || '1050002');
resetJob(jobId)
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
  });
