/**
 * Database Connection Manager
 * Handles connection pooling, retry logic, and keep-alive for long-running jobs
 */

import { getDb } from "./db";

export interface ConnectionConfig {
  maxRetries: number;
  retryDelay: number;
  keepAliveInterval: number;
}

export const DEFAULT_CONNECTION_CONFIG: ConnectionConfig = {
  maxRetries: 5,
  retryDelay: 2000, // 2 seconds
  keepAliveInterval: 30000, // 30 seconds
};

/**
 * Execute a database query with automatic retry on connection errors
 */
export async function executeWithRetry<T>(
  operation: () => Promise<T>,
  config: ConnectionConfig = DEFAULT_CONNECTION_CONFIG
): Promise<T> {
  let lastError: any;

  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;
      
      // Check if it's a connection error
      const isConnectionError = 
        error.message?.includes("ECONNRESET") ||
        error.message?.includes("Connection") ||
        error.message?.includes("ETIMEDOUT") ||
        error.message?.includes("ENOTFOUND") ||
        error.code === "ECONNRESET" ||
        error.code === "ETIMEDOUT";

      if (isConnectionError && attempt < config.maxRetries) {
        console.warn(`[DB Connection] Attempt ${attempt}/${config.maxRetries} failed with connection error, retrying...`);
        console.warn(`[DB Connection] Error: ${error.message}`);
        
        // Exponential backoff
        const delay = config.retryDelay * Math.pow(1.5, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      // Non-connection error or max retries reached
      throw error;
    }
  }

  throw lastError;
}

/**
 * Keep-alive mechanism for long-running jobs
 * Periodically executes a lightweight query to keep the connection alive
 */
export class ConnectionKeepAlive {
  private intervalId: NodeJS.Timeout | null = null;
  private isActive: boolean = false;

  constructor(private config: ConnectionConfig = DEFAULT_CONNECTION_CONFIG) {}

  /**
   * Start the keep-alive mechanism
   */
  start(): void {
    if (this.isActive) {
      console.warn("[DB Keep-Alive] Already active");
      return;
    }

    this.isActive = true;
    console.log(`[DB Keep-Alive] Starting with ${this.config.keepAliveInterval}ms interval`);

    this.intervalId = setInterval(async () => {
      try {
        // Execute a lightweight query to keep connection alive
        const db = await getDb();
        if (db) {
          await db.execute("SELECT 1");
        }
        console.log("[DB Keep-Alive] Ping successful");
      } catch (error: any) {
        console.error("[DB Keep-Alive] Ping failed:", error.message);
      }
    }, this.config.keepAliveInterval);
  }

  /**
   * Stop the keep-alive mechanism
   */
  stop(): void {
    if (!this.isActive) {
      return;
    }

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.isActive = false;
    console.log("[DB Keep-Alive] Stopped");
  }

  /**
   * Check if keep-alive is active
   */
  isRunning(): boolean {
    return this.isActive;
  }
}

/**
 * Transaction wrapper with retry logic
 */
export async function executeTransaction<T>(
  operation: () => Promise<T>,
  config: ConnectionConfig = DEFAULT_CONNECTION_CONFIG
): Promise<T> {
  return executeWithRetry(async () => {
    // Note: Drizzle doesn't have explicit transaction support in the same way
    // For now, we'll just execute with retry
    // If you need true transactions, you'd use db.transaction()
    return await operation();
  }, config);
}

/**
 * Batch update helper with connection resilience
 */
export async function batchUpdate<T>(
  items: T[],
  updateFn: (item: T) => Promise<void>,
  batchSize: number = 10,
  config: ConnectionConfig = DEFAULT_CONNECTION_CONFIG
): Promise<void> {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    
    await executeWithRetry(async () => {
      await Promise.all(batch.map(item => updateFn(item)));
    }, config);
    
    // Small delay between batches to avoid overwhelming the DB
    if (i + batchSize < items.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

/**
 * Health check for database connection
 */
export async function checkDatabaseHealth(): Promise<{
  healthy: boolean;
  latency: number;
  error?: string;
}> {
  const startTime = Date.now();
  
  try {
    const db = await getDb();
    if (!db) {
      return {
        healthy: false,
        latency: Date.now() - startTime,
        error: "Database not available",
      };
    }
    await db.execute("SELECT 1");
    const latency = Date.now() - startTime;
    
    return {
      healthy: true,
      latency,
    };
  } catch (error: any) {
    return {
      healthy: false,
      latency: Date.now() - startTime,
      error: error.message,
    };
  }
}
