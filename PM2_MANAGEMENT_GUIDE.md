# PM2 Management Guide for VC Enrichment

## Overview

Both the **dev server** and **background worker** are now managed by PM2, ensuring they:
- ✅ Auto-restart on crash
- ✅ Auto-start on system boot/sandbox reset
- ✅ Persist across sessions
- ✅ Provide centralized logging and monitoring

---

## Quick Reference

### Check Status
```bash
pm2 status
```

Shows both processes:
- `vc-enrichment-server` - Web server (port 3000)
- `vc-enrichment-worker` - Background job processor

### View Logs
```bash
# All logs
pm2 logs

# Server only
pm2 logs vc-enrichment-server

# Worker only
pm2 logs vc-enrichment-worker

# Last 100 lines
pm2 logs --lines 100

# Errors only
pm2 logs --err
```

### Restart Processes
```bash
# Restart both
pm2 restart all

# Restart server only
pm2 restart vc-enrichment-server

# Restart worker only
pm2 restart vc-enrichment-worker
```

### Stop/Start
```bash
# Stop all
pm2 stop all

# Start all
pm2 start ecosystem.config.cjs

# Stop specific process
pm2 stop vc-enrichment-server
```

### Monitor
```bash
# Real-time dashboard
pm2 monit

# Shows CPU, memory, logs in real-time
```

---

## Process Details

### vc-enrichment-server
- **Purpose:** Web server for the VC Enrichment application
- **Port:** 3000
- **Command:** `pnpm dev`
- **Auto-restart:** Yes (max 10 restarts)
- **Memory limit:** 1GB (restarts if exceeded)
- **Logs:**
  - Output: `/home/ubuntu/logs/vc-server-out.log`
  - Errors: `/home/ubuntu/logs/vc-server-error.log`

### vc-enrichment-worker
- **Purpose:** Background job processor for enrichment jobs
- **Command:** `pnpm tsx server/worker.ts`
- **Auto-restart:** Yes (max 10 restarts)
- **Memory limit:** 2GB (restarts if exceeded)
- **Logs:**
  - Output: `/home/ubuntu/logs/vc-worker-out.log`
  - Errors: `/home/ubuntu/logs/vc-worker-error.log`

---

## Auto-Start Configuration

PM2 is configured to automatically start both processes on system boot:

```bash
# Check auto-start status
systemctl status pm2-ubuntu

# Disable auto-start (not recommended)
pm2 unstartup systemd

# Re-enable auto-start
pm2 startup systemd
pm2 save
```

**Important:** After making changes to processes (adding/removing), always run:
```bash
pm2 save
```

This saves the current process list so PM2 knows what to start on boot.

---

## Common Issues

### Server Not Responding

**Check if running:**
```bash
pm2 status
```

**If status shows "stopped" or "errored":**
```bash
pm2 restart vc-enrichment-server
pm2 logs vc-enrichment-server --err --lines 50
```

**If server keeps crashing:**
```bash
# Check error logs
tail -100 /home/ubuntu/logs/vc-server-error.log

# Common causes:
# - Port 3000 already in use
# - Database connection failed
# - Out of memory
```

### Worker Not Processing Jobs

**Check worker status:**
```bash
pm2 status vc-enrichment-worker
pm2 logs vc-enrichment-worker --lines 50
```

**Check if worker is stuck:**
```bash
# Run job check script
cd /home/ubuntu/vc-enrichment-web
pnpm tsx check-jobs.ts
```

**Restart worker:**
```bash
pm2 restart vc-enrichment-worker
```

### High Memory Usage

**Check memory:**
```bash
pm2 status  # Shows memory per process
pm2 monit   # Real-time memory graph
```

**If memory exceeds limit:**
- PM2 will automatically restart the process
- Jobs resume from last checkpoint
- No data loss

**To increase memory limit:**
Edit `ecosystem.config.cjs` and change `max_memory_restart`:
```javascript
max_memory_restart: '4G',  // Increase to 4GB
```

Then restart:
```bash
pm2 delete all
pm2 start ecosystem.config.cjs
pm2 save
```

### Processes Not Auto-Starting on Boot

**Check systemd service:**
```bash
systemctl status pm2-ubuntu
```

**If service is disabled:**
```bash
sudo systemctl enable pm2-ubuntu
sudo systemctl start pm2-ubuntu
```

**Verify saved process list:**
```bash
cat /home/ubuntu/.pm2/dump.pm2
```

Should show both `vc-enrichment-server` and `vc-enrichment-worker`.

---

## Advanced Operations

### Update Code and Restart

```bash
cd /home/ubuntu/vc-enrichment-web

# Pull latest code
git pull

# Install dependencies
pnpm install

# Restart processes
pm2 restart all

# Save state
pm2 save
```

### View Process Details

```bash
# Detailed info for all processes
pm2 show all

# Detailed info for specific process
pm2 show vc-enrichment-server
```

### Clear Logs

```bash
# Clear all PM2 logs
pm2 flush

# Clear specific log files
> /home/ubuntu/logs/vc-server-out.log
> /home/ubuntu/logs/vc-server-error.log
```

### Change Process Configuration

1. Edit `ecosystem.config.cjs`
2. Delete and restart processes:
```bash
pm2 delete all
pm2 start ecosystem.config.cjs
pm2 save
```

### Run Multiple Workers

To process multiple jobs concurrently:

```bash
# Stop current worker
pm2 stop vc-enrichment-worker

# Start 3 worker instances
pm2 start ecosystem.config.cjs --only vc-enrichment-worker -i 3

# Save state
pm2 save
```

Each worker will claim different jobs from the queue.

---

## Monitoring & Alerts

### Real-Time Monitoring

```bash
# Interactive dashboard
pm2 monit

# Web-based monitoring (requires PM2 Plus account)
pm2 plus
```

### Log Monitoring

```bash
# Tail logs in real-time
pm2 logs --lines 0

# Watch for errors
pm2 logs --err --lines 0

# Filter by process
pm2 logs vc-enrichment-worker --lines 0
```

### Health Checks

Create a cron job to check PM2 health:

```bash
# Add to crontab
crontab -e

# Add this line (check every 5 minutes)
*/5 * * * * /home/ubuntu/.nvm/versions/node/v22.13.0/bin/pm2 ping
```

---

## Troubleshooting Checklist

### Server Won't Start

- [ ] Check if port 3000 is available: `lsof -i :3000`
- [ ] Check database connection: `pnpm tsx check-jobs.ts`
- [ ] Check environment variables: `pm2 show vc-enrichment-server`
- [ ] Check error logs: `pm2 logs vc-enrichment-server --err`
- [ ] Try manual start: `cd /home/ubuntu/vc-enrichment-web && pnpm dev`

### Worker Won't Process Jobs

- [ ] Check worker status: `pm2 status vc-enrichment-worker`
- [ ] Check for pending jobs: `pnpm tsx check-pending-jobs.ts`
- [ ] Check worker logs: `pm2 logs vc-enrichment-worker`
- [ ] Check database connection
- [ ] Restart worker: `pm2 restart vc-enrichment-worker`

### Processes Keep Crashing

- [ ] Check memory usage: `pm2 monit`
- [ ] Check error logs: `tail -100 /home/ubuntu/logs/*-error.log`
- [ ] Check system resources: `free -h && df -h`
- [ ] Increase restart delay in `ecosystem.config.cjs`
- [ ] Increase memory limit in `ecosystem.config.cjs`

---

## Best Practices

1. **Always save after changes:** `pm2 save`
2. **Monitor logs regularly:** `pm2 logs`
3. **Check status daily:** `pm2 status`
4. **Keep PM2 updated:** `npm install -g pm2@latest`
5. **Backup logs weekly:** `tar -czf logs-backup-$(date +%Y%m%d).tar.gz /home/ubuntu/logs/`
6. **Test auto-start:** Reboot and verify processes restart

---

## Quick Commands Cheat Sheet

```bash
# Status
pm2 status

# Logs
pm2 logs

# Restart all
pm2 restart all

# Monitor
pm2 monit

# Save state
pm2 save

# Stop all
pm2 stop all

# Start all
pm2 start ecosystem.config.cjs

# Delete all
pm2 delete all
```

---

## Support

For PM2-specific issues, see:
- PM2 Documentation: https://pm2.keymetrics.io/docs/
- PM2 GitHub: https://github.com/Unitech/pm2

For VC Enrichment issues, check:
- `JOB_STOPPAGE_ANALYSIS.md` - Job troubleshooting
- `WORKER_GUIDE.md` - Worker-specific operations
- `TROUBLESHOOTING_SUMMARY.md` - General troubleshooting
