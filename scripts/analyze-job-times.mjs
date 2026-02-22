import { db } from '../server/db.js';
import { enrichmentJobs } from '../drizzle/schema.js';
import { desc, eq } from 'drizzle-orm';

const jobs = await db.select({
  id: enrichmentJobs.id,
  firmCount: enrichmentJobs.firmCount,
  createdAt: enrichmentJobs.createdAt,
  updatedAt: enrichmentJobs.updatedAt,
  status: enrichmentJobs.status
}).from(enrichmentJobs)
  .where(eq(enrichmentJobs.status, 'completed'))
  .orderBy(desc(enrichmentJobs.createdAt))
  .limit(10);

console.log('Recent Completed Jobs:');
console.log('ID     | Firms | Duration (s) | Sec/Firm');
console.log('-------|-------|--------------|----------');

const times = [];

for (const job of jobs) {
  const durationMs = job.updatedAt.getTime() - job.createdAt.getTime();
  const durationSec = Math.round(durationMs / 1000);
  const secPerFirm = (durationSec / job.firmCount).toFixed(1);
  times.push(durationSec / job.firmCount);
  console.log(`${job.id} | ${String(job.firmCount).padStart(5)} | ${String(durationSec).padStart(12)} | ${String(secPerFirm).padStart(8)}`);
}

const avgSecPerFirm = times.reduce((a, b) => a + b, 0) / times.length;
const minSecPerFirm = Math.min(...times);
const maxSecPerFirm = Math.max(...times);

console.log(`\nStatistics:`);
console.log(`  Average: ${avgSecPerFirm.toFixed(1)} seconds per firm`);
console.log(`  Min: ${minSecPerFirm.toFixed(1)} seconds per firm`);
console.log(`  Max: ${maxSecPerFirm.toFixed(1)} seconds per firm`);

process.exit(0);
