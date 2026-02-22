# Chrome Auto-Install System

## Overview

The VC Enrichment worker requires Chrome/Puppeteer for scraping JavaScript-rendered websites (e.g., a16z, Sequoia, Accel). This system ensures Chrome is automatically installed and verified on every worker startup, preventing data loss from missing browser dependencies after sandbox resets.

## Architecture

### Components

1. **`scripts/install-chrome.sh`** - Chrome installation and verification script
2. **`scripts/start-worker.sh`** - Worker startup wrapper that runs Chrome check
3. **`ecosystem.config.cjs`** - PM2 configuration using startup wrapper

### Flow

```
PM2 starts worker
    ↓
start-worker.sh executes
    ↓
install-chrome.sh runs
    ↓
Check if Chrome exists
    ↓
    ├─ YES → Verify Puppeteer works → ✅ Start worker
    └─ NO → Install system deps → Install Chrome → Install Puppeteer → ✅ Start worker
```

## Installation Script Features

### Smart Detection
- Checks if Chrome is already installed
- Verifies Puppeteer can launch browser
- Only reinstalls if verification fails

### System Dependencies
Installs required packages:
- fonts-liberation
- libnss3, libxss1
- libasound2
- libatk-bridge2.0-0, libatk1.0-0
- libatspi2.0-0
- libcups2, libdbus-1-3
- libdrm2, libgbm1
- libgtk-3-0
- libnspr4
- libxcomposite1, libxdamage1, libxfixes3
- libxkbcommon0, libxrandr2
- xdg-utils, wget, ca-certificates

### Chrome Installation
- Downloads latest stable Chrome from Google
- Installs via dpkg
- Verifies installation with `google-chrome-stable --version`

### Puppeteer Setup
- Clears old Puppeteer cache if reinstalling
- Installs Puppeteer browser binaries
- Tests browser launch to verify functionality

### Logging
All steps logged with `[Chrome Install]` prefix:
- ✅ Success: Chrome and Puppeteer working
- ⚠️ Warning: Verification failed, reinstalling
- ❌ Error: Installation verification failed

## PM2 Integration

### Configuration

```javascript
{
  name: 'vc-enrichment-worker',
  script: '/home/ubuntu/vc-enrichment-web/scripts/start-worker.sh',
  cwd: '/home/ubuntu/vc-enrichment-web',
  autorestart: true,
  max_restarts: 10,
  // ... other PM2 settings
}
```

### Auto-Start on Boot

PM2 configured to start on system boot:
```bash
pm2 startup  # Configure system startup
pm2 save     # Save current process list
```

## Usage

### Manual Chrome Check/Install
```bash
/home/ubuntu/vc-enrichment-web/scripts/install-chrome.sh
```

### Manual Worker Start
```bash
/home/ubuntu/vc-enrichment-web/scripts/start-worker.sh
```

### PM2 Commands
```bash
# Restart worker (triggers Chrome check)
pm2 restart vc-enrichment-worker

# View startup logs
pm2 logs vc-enrichment-worker --lines 50

# Check worker status
pm2 status
```

## Troubleshooting

### Chrome Not Installing

**Symptom:** Installation script fails or times out

**Solutions:**
1. Check internet connectivity: `ping google.com`
2. Update apt cache: `sudo apt-get update`
3. Check disk space: `df -h`
4. Review logs: `pm2 logs vc-enrichment-worker --err`

### Puppeteer Verification Fails

**Symptom:** Chrome installs but Puppeteer test fails

**Solutions:**
1. Clear Puppeteer cache: `rm -rf ~/.cache/puppeteer`
2. Reinstall Puppeteer: `cd /home/ubuntu/vc-enrichment-web && pnpm install puppeteer --force`
3. Check Chrome version: `google-chrome-stable --version`
4. Test manually:
   ```bash
   cd /home/ubuntu/vc-enrichment-web
   node -e "const puppeteer = require('puppeteer'); puppeteer.launch({headless: true}).then(b => b.close());"
   ```

### Worker Crashes on Startup

**Symptom:** Worker starts then immediately crashes

**Solutions:**
1. Check startup script permissions: `ls -l scripts/*.sh`
2. Make executable: `chmod +x scripts/*.sh`
3. Test startup script manually: `/home/ubuntu/vc-enrichment-web/scripts/start-worker.sh`
4. Review error logs: `pm2 logs vc-enrichment-worker --err --lines 100`

### Data Loss Still Occurring

**Symptom:** JS-rendered sites returning 0 team members

**Solutions:**
1. Verify Chrome is working:
   ```bash
   google-chrome-stable --version
   ```
2. Check worker logs for browser errors:
   ```bash
   pm2 logs vc-enrichment-worker | grep -i "browser\|chrome\|puppeteer"
   ```
3. Test scraper directly:
   ```bash
   cd /home/ubuntu/vc-enrichment-web
   node -e "const { ComprehensiveScraper } = require('./server/ComprehensiveScraper'); (async () => { const scraper = new ComprehensiveScraper(); const html = await scraper.scrape('https://a16z.com/team/'); console.log('HTML length:', html.length); })();"
   ```

## Benefits

### Reliability
- **Zero data loss** from missing Chrome after sandbox resets
- **Automatic recovery** if Chrome becomes corrupted
- **Verified installation** before worker starts processing

### Maintainability
- **Single source of truth** for Chrome installation
- **Centralized logging** for debugging
- **Easy updates** - modify one script

### Performance
- **Fast startup** - only installs if needed (~5s check vs ~60s install)
- **No manual intervention** - fully automated
- **Persistent across reboots** - PM2 auto-start configured

## Testing

### Test Auto-Install on Fresh Sandbox

1. Simulate missing Chrome:
   ```bash
   sudo apt-get remove -y google-chrome-stable
   rm -rf ~/.cache/puppeteer
   ```

2. Restart worker:
   ```bash
   pm2 restart vc-enrichment-worker
   ```

3. Verify installation in logs:
   ```bash
   pm2 logs vc-enrichment-worker --lines 50 | grep "Chrome Install"
   ```

4. Expected output:
   ```
   [Chrome Install] Chrome not found, installing...
   [Chrome Install] Installing system dependencies...
   [Chrome Install] Chrome installed: Google Chrome 143.x.xxxx.xxx
   [Chrome Install] ✅ Chrome and Puppeteer installed successfully!
   ```

### Test Existing Chrome Detection

1. Restart worker with Chrome already installed:
   ```bash
   pm2 restart vc-enrichment-worker
   ```

2. Verify quick startup:
   ```bash
   pm2 logs vc-enrichment-worker --lines 20 | grep "Chrome Install"
   ```

3. Expected output:
   ```
   [Chrome Install] Chrome already installed: Google Chrome 143.x.xxxx.xxx
   [Chrome Install] ✅ Chrome and Puppeteer are working correctly
   ```

### Test Data Extraction

1. Upload test file with JS-rendered sites (a16z, Sequoia, Accel)
2. Monitor processing:
   ```bash
   pm2 logs vc-enrichment-worker --lines 0 -f
   ```
3. Verify team member counts:
   - a16z: ~90 Tier 1 members
   - Sequoia: ~50+ Tier 1 members
   - Accel: ~40+ Tier 1 members

## Future Improvements

### Potential Enhancements

1. **Version pinning** - Lock Chrome to specific version for consistency
2. **Health checks** - Periodic Chrome verification during long jobs
3. **Fallback strategies** - Alternative scraping if Chrome fails
4. **Metrics tracking** - Log Chrome usage statistics
5. **Docker integration** - Pre-built image with Chrome included

### Known Limitations

1. **Installation time** - First install takes ~60 seconds
2. **Disk space** - Chrome requires ~300MB
3. **System dependencies** - Requires sudo access for apt-get
4. **Network dependency** - Requires internet to download Chrome

## Related Documentation

- [PM2 Management Guide](./PM2_MANAGEMENT.md) - PM2 configuration and commands
- [Data Quality Issues](./DATA_QUALITY_ISSUES.md) - Data loss root causes
- [Scalability Architecture](./SCALABILITY_ARCHITECTURE.md) - System design
