import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import { enrichmentJobs } from './drizzle/schema';
import { desc } from 'drizzle-orm';

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL!);
  const db = drizzle(conn);
  
  const jobs = await db.select()
    .from(enrichmentJobs)
    .orderBy(desc(enrichmentJobs.id))
    .limit(5);
  
  console.log('\n=== Recent Jobs ===\n');
  
  for (const job of jobs) {
    console.log(`Job ID: ${job.id}`);
    console.log(`  Status: ${job.status}`);
    console.log(`  Progress: ${job.processedCount}/${job.firmCount} firms`);
    console.log(`  Current Firm: ${job.currentFirmName || 'N/A'}`);
    console.log(`  Worker PID: ${job.workerPid || 'None'}`);
    console.log(`  Last Heartbeat: ${job.heartbeatAt || 'Never'}`);
    console.log(`  Started At: ${job.startedAt || 'Never'}`);
    console.log(`  Updated At: ${job.updatedAt}`);
    console.log(`  Error: ${job.errorMessage || 'None'}`);
    
    // Calculate time since last update
    const now = new Date();
    const lastUpdate = new Date(job.updatedAt);
    const minutesSinceUpdate = Math.round((now.getTime() - lastUpdate.getTime()) / 60000);
    console.log(`  Minutes Since Update: ${minutesSinceUpdate}`);
    
    console.log('');
  }
  
  await conn.end();
  process.exit(0);
}

main().catch(console.error);
