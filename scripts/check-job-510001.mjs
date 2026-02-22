import { getDb } from '../server/db.ts';
import { enrichmentJobs, vcFirms, teamMembers } from '../drizzle/schema.ts';
import { eq, desc } from 'drizzle-orm';

const db = await getDb();
if (!db) {
  console.error('Database not available');
  process.exit(1);
}

// Find most recent completed jobs
const jobs = await db.select().from(enrichmentJobs).orderBy(desc(enrichmentJobs.createdAt)).limit(10);
console.log('Recent jobs:');
jobs.forEach(j => console.log(`  Job ${j.id}: ${j.status} | ${j.completedFirms}/${j.totalFirms} firms | Created: ${j.createdAt}`));

// Get Job 510001 details
const job = jobs.find(j => j.id === 510001);
if (!job) {
  console.log('\nJob 510001 not found');
  process.exit(1);
}

console.log('\n=== Job 510001 Details ===');
console.log('Status:', job.status);
console.log('Firms:', `${job.completedFirms}/${j.totalFirms}`);
console.log('Created:', job.createdAt);
console.log('Updated:', job.updatedAt);

// Get firms for this job
const firms = await db.select().from(vcFirms).where(eq(vcFirms.jobId, 510001));
console.log('\n=== Firms (', firms.length, ') ===');
firms.forEach(f => console.log(`  - ${f.name} | ${f.website}`));

// Get team members with tier distribution
const members = await db.select().from(teamMembers).where(eq(teamMembers.jobId, 510001));
console.log('\n=== Team Members ===');
console.log('Total:', members.length);

const tierCounts = members.reduce((acc, m) => {
  acc[m.tier || 'unknown'] = (acc[m.tier || 'unknown'] || 0) + 1;
  return acc;
}, {});
console.log('Tier distribution:', tierCounts);

// Breakdown by firm
console.log('\n=== Members by Firm ===');
const firmCounts = {};
members.forEach(m => {
  if (!firmCounts[m.firm]) {
    firmCounts[m.firm] = { total: 0, tier1: 0, tier2: 0, tier3: 0 };
  }
  firmCounts[m.firm].total++;
  if (m.tier === 'Tier 1') firmCounts[m.firm].tier1++;
  if (m.tier === 'Tier 2') firmCounts[m.firm].tier2++;
  if (m.tier === 'Tier 3') firmCounts[m.firm].tier3++;
});

Object.entries(firmCounts).forEach(([firm, counts]) => {
  console.log(`  ${firm}: ${counts.total} total (T1: ${counts.tier1}, T2: ${counts.tier2}, T3: ${counts.tier3})`);
});

// Sample members from each tier
console.log('\n=== Sample Tier 1 Members ===');
members.filter(m => m.tier === 'Tier 1').slice(0, 10).forEach(m => 
  console.log(`  - ${m.name} | ${m.title} | ${m.firm}`)
);

console.log('\n=== Sample Tier 2 Members ===');
members.filter(m => m.tier === 'Tier 2').slice(0, 10).forEach(m => 
  console.log(`  - ${m.name} | ${m.title} | ${m.firm}`)
);

console.log('\n=== Sample Tier 3 Members ===');
members.filter(m => m.tier === 'Tier 3').slice(0, 10).forEach(m => 
  console.log(`  - ${m.name} | ${m.title} | ${m.firm}`)
);

process.exit(0);
