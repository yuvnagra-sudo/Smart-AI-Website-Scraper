# VC Enrichment Worker Guide

## Overview

The VC Enrichment Worker is a persistent background process that automatically processes enrichment jobs without supervision. It features:

- **Automatic Recovery**: Resumes jobs from last checkpoint if worker crashes
- **Stale Job Detection**: Automatically recovers jobs that appear stuck
- **Heartbeat Monitoring**: Tracks worker health in real-time
- **Graceful Shutdown**: Properly releases jobs when stopped
- **PM2 Management**: Automatic restart on crash, process monitoring

---

## Quick Start

### Start the Worker
```bash
cd /home/ubuntu/vc-enrichment-web
pm2 start ecosystem.config.js
pm2 save  # Save process list for auto-start
```

### Check Status
```bash
pm2 status
```

### View Logs
```bash
# Tail logs in real-time
pm2 logs vc-enrichment-worker

# View last 100 lines
pm2 logs vc-enrichment-worker --lines 100

# View only errors
pm2 logs vc-enrichment-worker --err
```

### Stop the Worker
```bash
pm2 stop vc-enrichment-worker
```

### Restart the Worker
```bash
pm2 restart vc-enrichment-worker
```

---

## How It Works

### 1. Job Queue System

When a user uploads an Excel file:
1. Web server creates a job record with status="pending"
2. Worker polls database every 5 seconds for pending jobs
3. Worker claims the job (sets status="processing", workerPid=<pid>)
4. Worker processes firms one by one, updating progress every 10 firms
5. Worker sends heartbeat every 30 seconds to prove it's alive
6. When complete, worker sets status="completed"

### 2. Automatic Recovery

**Scenario 1: Worker Crashes Mid-Job**
- Worker stops sending heartbeats
- After 5 minutes without heartbeat, job is marked as "stale"
- When worker restarts, it detects the stale job
- Worker resets job to "pending" and resumes from last checkpoint

**Scenario 2: Server Restarts**
- PM2 automatically restarts the worker on boot (if configured)
- Worker detects incomplete jobs and resumes them

**Scenario 3: Job Hangs**
- Worker sends heartbeats but makes no progress
- Manual intervention required (restart worker or reset job)

### 3. Progress Checkpointing

Progress is saved to database every 10 firms:
- `processedCount`: Number of firms completed
- `currentFirmName`: Name of firm being processed
- `currentTeamMemberCount`: Team members found in current firm
- `updatedAt`: Last update timestamp

If worker crashes, it resumes from `processedCount` on restart.

---

## Monitoring

### Real-Time Monitoring
```bash
# Interactive dashboard
pm2 monit

# Shows:
# - CPU and memory usage
# - Logs in real-time
# - Process status
```

### Check Job Progress

**Option 1: Database Query**
```bash
cd /home/ubuntu/vc-enrichment-web
pnpm tsx -e "
import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import { enrichmentJobs } from './drizzle/schema';
import { eq } from 'drizzle-orm';

const conn = await mysql.createConnection(process.env.DATABASE_URL);
const db = drizzle(conn);

const jobs = await db.select()
  .from(enrichmentJobs)
  .where(eq(enrichmentJobs.status, 'processing'));

jobs.forEach(job => {
  console.log(\`Job \${job.id}: \${job.processedCount}/\${job.firmCount} firms\`);
  console.log(\`Current: \${job.currentFirmName}\`);
  console.log(\`Last heartbeat: \${job.heartbeatAt}\`);
});

process.exit(0);
"
```

**Option 2: Dashboard UI**
- Go to the Dashboard page
- View real-time progress for all jobs

### Log Files

Logs are stored in `/home/ubuntu/logs/`:
- `vc-worker-out.log`: Standard output (progress, info)
- `vc-worker-error.log`: Errors and warnings

```bash
# Tail output log
tail -f /home/ubuntu/logs/vc-worker-out.log

# Tail error log
tail -f /home/ubuntu/logs/vc-worker-error.log

# Search for specific job
grep "Job 330001" /home/ubuntu/logs/vc-worker-out.log
```

---

## Troubleshooting

### Worker Not Starting

**Check if PM2 is running:**
```bash
pm2 status
```

**Check logs for errors:**
```bash
pm2 logs vc-enrichment-worker --err --lines 50
```

**Common issues:**
- Database connection failed: Check `DATABASE_URL` env var
- Port already in use: Another worker instance running
- Permission denied: Check file permissions

**Solution:**
```bash
# Stop all PM2 processes
pm2 delete all

# Restart worker
cd /home/ubuntu/vc-enrichment-web
pm2 start ecosystem.config.js
```

### Job Stuck (No Progress)

**Symptoms:**
- `processedCount` not increasing
- `updatedAt` timestamp not changing
- Heartbeat timestamp is recent (worker is alive)

**Possible causes:**
- Firm taking very long to process (complex website)
- Network timeout or rate limiting
- Infinite loop in code

**Solution:**
```bash
# Check logs to see which firm is stuck
pm2 logs vc-enrichment-worker --lines 100 | grep "Starting for:"

# Restart worker (will resume from last checkpoint)
pm2 restart vc-enrichment-worker
```

### Job Marked as Stale

**Symptoms:**
- Worker log shows "Found stale job"
- Job was processing but heartbeat stopped

**Cause:**
- Worker crashed without graceful shutdown
- System ran out of memory
- Database connection lost

**Solution:**
- Worker automatically recovers stale jobs
- Check error logs to identify crash cause
- Increase memory limit if needed (edit `ecosystem.config.js`)

### High Memory Usage

**Check memory usage:**
```bash
pm2 status  # Shows memory per process
pm2 monit   # Real-time memory graph
```

**If memory exceeds 2GB:**
- Worker will automatically restart (configured in PM2)
- Job will resume from last checkpoint
- No data loss

**To prevent:**
- Reduce batch size (edit `server/routers.ts`, line 222)
- Increase checkpoint frequency (edit line 224)

### Database Connection Lost

**Symptoms:**
- Error: "Connection lost" or "Too many connections"
- Job status not updating

**Solution:**
```bash
# Restart worker
pm2 restart vc-enrichment-worker

# If problem persists, check database server
# Connection keep-alive is enabled in code
```

---

## Advanced Operations

### Process Multiple Jobs Concurrently

**Current:** Worker processes one job at a time  
**To enable parallel processing:**

1. Edit `server/worker.ts`:
```typescript
// Change from:
const CONCURRENCY = 1;

// To:
const CONCURRENCY = 3; // Process 3 jobs simultaneously
```

2. Start multiple worker instances:
```bash
pm2 start ecosystem.config.js -i 3  # 3 instances
```

**Note:** Each worker needs ~1-2GB memory. Monitor total memory usage.

### Manually Reset a Job

**If a job is stuck and won't auto-recover:**

```sql
-- Reset job to pending
UPDATE enrichmentJobs 
SET status = 'pending', 
    workerPid = NULL, 
    heartbeatAt = NULL
WHERE id = <JOB_ID>;
```

**Or reset progress to start over:**

```sql
UPDATE enrichmentJobs 
SET status = 'pending',
    processedCount = 0,
    workerPid = NULL,
    heartbeatAt = NULL
WHERE id = <JOB_ID>;
```

### Configure Auto-Start on Boot

```bash
# Generate startup script
pm2 startup

# Follow the instructions (will show a command to run with sudo)

# Save current process list
pm2 save

# Now worker will start automatically on system reboot
```

### Stop Auto-Start

```bash
pm2 unstartup
```

---

## Performance Tuning

### Batch Size

**Location:** `server/routers.ts`, line 222

```typescript
batchSize: 500, // Process 500 firms per batch
```

**Recommendations:**
- Small jobs (<100 firms): 50-100
- Medium jobs (100-1000 firms): 500
- Large jobs (1000+ firms): 1000

**Trade-offs:**
- Larger batches = less database updates = faster
- Smaller batches = more frequent checkpoints = better recovery

### Progress Update Interval

**Location:** `server/routers.ts`, line 224

```typescript
progressUpdateInterval: 10, // Update DB every 10 firms
```

**Recommendations:**
- Frequent updates (5-10): Better monitoring, more database load
- Infrequent updates (20-50): Less database load, larger recovery window

### Heartbeat Interval

**Location:** `server/worker.ts`, line 17

```typescript
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
```

**Recommendations:**
- Shorter interval (15-30s): Faster stale detection
- Longer interval (60s): Less database load

### Stale Threshold

**Location:** `server/worker.ts`, line 18

```typescript
const STALE_THRESHOLD = 5 * 60 * 1000; // 5 minutes
```

**Recommendations:**
- Shorter threshold (2-3 min): Faster recovery, more false positives
- Longer threshold (10 min): Fewer false positives, slower recovery

---

## Maintenance

### View Worker Uptime
```bash
pm2 status
# Shows uptime since last restart
```

### Clear Logs
```bash
pm2 flush  # Clear all PM2 logs
```

### Update Worker Code

```bash
# Stop worker
pm2 stop vc-enrichment-worker

# Pull latest code
cd /home/ubuntu/vc-enrichment-web
git pull

# Install dependencies
pnpm install

# Restart worker
pm2 restart vc-enrichment-worker
```

### Backup Logs

```bash
# Compress and backup logs
tar -czf logs-backup-$(date +%Y%m%d).tar.gz /home/ubuntu/logs/

# Move to backup location
mv logs-backup-*.tar.gz /home/ubuntu/backups/
```

---

## FAQ

**Q: Can I run multiple workers?**  
A: Yes, start with `pm2 start ecosystem.config.js -i 3` for 3 instances. Each worker will claim different jobs.

**Q: What happens if I stop the worker mid-job?**  
A: The job is marked as "pending" and will resume from the last checkpoint when worker restarts.

**Q: How do I know if the worker is healthy?**  
A: Check `pm2 status` and verify `heartbeatAt` timestamp is recent in the database.

**Q: Can I pause a job?**  
A: Yes, stop the worker with `pm2 stop vc-enrichment-worker`. The job will resume when you restart.

**Q: How long does a large job take?**  
A: ~30-60 seconds per firm. For 7547 firms: 63-126 hours (2.6-5.3 days).

**Q: Can I speed up processing?**  
A: Yes, run multiple workers in parallel or increase batch size (see Performance Tuning).

**Q: What if a firm fails to enrich?**  
A: The worker retries 3 times with exponential backoff, then skips and continues. Failed firms are logged.

**Q: How do I see which firms failed?**  
A: Check the error log: `grep "failed for item" /home/ubuntu/logs/vc-worker-error.log`

---

## Support

For issues or questions:
1. Check logs: `pm2 logs vc-enrichment-worker`
2. Check worker status: `pm2 status`
3. Check database for job status
4. Review this guide for troubleshooting steps

**Common Commands Cheat Sheet:**
```bash
# Start
pm2 start ecosystem.config.js

# Stop
pm2 stop vc-enrichment-worker

# Restart
pm2 restart vc-enrichment-worker

# Logs
pm2 logs vc-enrichment-worker

# Status
pm2 status

# Monitor
pm2 monit

# Save
pm2 save
```
