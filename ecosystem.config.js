// PM2 Ecosystem Configuration
 * 
 * This file configures PM2 to manage the VC enrichment worker process.
 * PM2 will automatically restart the worker if it crashes and can be
 * configured to start on system boot.
 * 
 * Commands:
 * - Start: pm2 start ecosystem.config.js
 * - Stop: pm2 stop vc-enrichment-worker
 * - Restart: pm2 restart vc-enrichment-worker
 * - Logs: pm2 logs vc-enrichment-worker
 * - Monitor: pm2 monit
 * - Status: pm2 status
 */

module.exports = {
  apps: [
    {
      name: 'vc-enrichment-worker',
      script: 'pnpm',
      args: 'tsx server/worker.ts',
      cwd: '/home/ubuntu/vc-enrichment-web',
      
      // Restart policy
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000, // Wait 5s before restarting
      
      // Logging
      error_file: '/home/ubuntu/logs/vc-worker-error.log',
      out_file: '/home/ubuntu/logs/vc-worker-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      
      // Environment
      env: {
        NODE_ENV: 'production',
      },
      
      // Resource limits
      max_memory_restart: '2G', // Restart if memory exceeds 2GB
      
      // Process management
      kill_timeout: 30000, // Wait 30s for graceful shutdown
      listen_timeout: 10000,
      
      // Monitoring
      instance_var: 'INSTANCE_ID',
    },
  ],
};
