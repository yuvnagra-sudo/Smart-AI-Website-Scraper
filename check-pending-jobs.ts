import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import { enrichmentJobs } from './drizzle/schema';
import { or, eq } from 'drizzle-orm';

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL!);
  const db = drizzle(conn);
  
  const jobs = await db.select()
    .from(enrichmentJobs)
    .where(or(
      eq(enrichmentJobs.status, 'pending'),
      eq(enrichmentJobs.status, 'processing')
    ));
  
  console.log('\n=== Pending/Processing Jobs ===\n');
  
  if (jobs.length === 0) {
    console.log('No pending or processing jobs found.');
  } else {
    jobs.forEach(j => {
      console.log(`Job ${j.id}:`);
      console.log(`  Status: ${j.status}`);
      console.log(`  Progress: ${j.processedCount}/${j.firmCount}`);
      console.log(`  Created: ${j.createdAt}`);
      console.log(`  Updated: ${j.updatedAt}`);
      console.log('');
    });
  }
  
  await conn.end();
  process.exit(0);
}

main().catch(console.error);
