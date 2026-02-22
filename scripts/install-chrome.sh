#!/bin/bash

# Chrome Installation Script for VC Enrichment Worker
# This script ensures Chrome and Puppeteer are available for browser-based scraping
# Run automatically on worker startup to survive sandbox resets

set -e  # Exit on any error

echo "[Chrome Install] Starting Chrome installation check..."

# Check if Chrome is already installed and working
if command -v google-chrome-stable &> /dev/null; then
    CHROME_VERSION=$(google-chrome-stable --version 2>/dev/null || echo "unknown")
    echo "[Chrome Install] Chrome already installed: $CHROME_VERSION"
    
    # Verify Puppeteer can find Chrome
    if [ -d "$HOME/.cache/puppeteer" ] && [ "$(ls -A $HOME/.cache/puppeteer)" ]; then
        echo "[Chrome Install] Puppeteer cache exists, checking browser..."
        cd /home/ubuntu/vc-enrichment-web
        
        # Quick test to verify browser works
        if node -e "const puppeteer = require('puppeteer'); puppeteer.launch({headless: true}).then(b => b.close()).then(() => console.log('OK'))" 2>/dev/null | grep -q "OK"; then
            echo "[Chrome Install] ✅ Chrome and Puppeteer are working correctly"
            exit 0
        else
            echo "[Chrome Install] ⚠️  Puppeteer browser test failed, reinstalling..."
        fi
    fi
else
    echo "[Chrome Install] Chrome not found, installing..."
fi

# Install system dependencies for Chrome
echo "[Chrome Install] Installing system dependencies..."
sudo apt-get update -qq
sudo apt-get install -y -qq \
    fonts-liberation \
    libnss3 \
    libxss1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    wget \
    ca-certificates \
    > /dev/null 2>&1

echo "[Chrome Install] System dependencies installed"

# Install Chrome browser
echo "[Chrome Install] Downloading and installing Chrome..."
cd /tmp
wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb || sudo apt-get install -f -y -qq
rm google-chrome-stable_current_amd64.deb

CHROME_VERSION=$(google-chrome-stable --version)
echo "[Chrome Install] Chrome installed: $CHROME_VERSION"

# Install Puppeteer browser binaries
echo "[Chrome Install] Installing Puppeteer browser binaries..."
cd /home/ubuntu/vc-enrichment-web

# Clear old Puppeteer cache to force fresh install
rm -rf $HOME/.cache/puppeteer

# Install Puppeteer browser
npx puppeteer browsers install chrome > /dev/null 2>&1 || {
    echo "[Chrome Install] ⚠️  Puppeteer browser install failed, trying alternative method..."
    node -e "const puppeteer = require('puppeteer'); (async () => { await puppeteer.launch({headless: true}).then(b => b.close()); })();" || true
}

# Verify installation
echo "[Chrome Install] Verifying installation..."
if node -e "const puppeteer = require('puppeteer'); puppeteer.launch({headless: true}).then(b => b.close()).then(() => console.log('OK'))" 2>/dev/null | grep -q "OK"; then
    echo "[Chrome Install] ✅ Chrome and Puppeteer installed successfully!"
    exit 0
else
    echo "[Chrome Install] ❌ Installation verification failed"
    exit 1
fi
