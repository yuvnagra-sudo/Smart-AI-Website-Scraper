import { db } from './server/db';

async function main() {
  const jobs = await db.query.enrichmentJobs.findMany({
    orderBy: (jobs, { desc }) => [desc(jobs.id)],
    limit: 3,
  });
  
  jobs.forEach(j => {
    console.log(`Job ID: ${j.id}`);
    console.log(`  Status: ${j.status}`);
    console.log(`  Progress: ${j.processedCount}/${j.totalCount}`);
    console.log(`  Current Firm: ${j.currentFirmName}`);
    console.log(`  Last Update: ${j.updatedAt}`);
    console.log('');
  });
}

main().catch(console.error);
