import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import path from "path";
import { spawn } from "child_process";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { runMigrations } from "../db";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  // Apply any pending DB schema migrations
  await runMigrations();

  const app = express();
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  // OAuth callback under /api/oauth/callback
  registerOAuthRoutes(app);
  // tRPC API with error handling
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
      onError({ error, type, path, input, ctx, req }) {
        console.error(`[tRPC Error] ${type} at ${path}:`, error);
        // Log additional context for debugging
        if (error.code === "INTERNAL_SERVER_ERROR") {
          console.error("[tRPC Error] Stack:", error.stack);
        }
      },
    })
  );
  
  // Global error handler to ensure JSON responses
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error("[Express Error]", err);
    
    // If headers already sent, delegate to default error handler
    if (res.headersSent) {
      return next(err);
    }
    
    // Always return JSON for API routes
    if (req.path.startsWith("/api/")) {
      return res.status(500).json({
        error: {
          message: err.message || "Internal server error",
          code: err.code || "INTERNAL_SERVER_ERROR",
        },
      });
    }
    
    // For non-API routes, continue with default error handling
    next(err);
  });
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);

// ---------------------------------------------------------------------------
// Auto-start the background worker in the same Railway service
//
// Railway runs a single process per service (the web server via `npm start`).
// The worker.ts polls the DB for pending jobs. Without spawning it here,
// jobs are queued with status="pending" but nothing ever picks them up —
// the worker log shows "Found job: None" indefinitely.
//
// We spawn it as a child process so:
//   1. It gets its own event loop (no blocking the HTTP server)
//   2. It restarts automatically if it crashes (up to MAX_RESTARTS times)
//   3. It inherits all env vars from the parent process
//   4. Its stdout/stderr are piped to the parent (visible in Railway logs)
//
// To disable (e.g. when running a dedicated worker service), set:
//   DISABLE_WORKER=true
// ---------------------------------------------------------------------------
function spawnWorker(attempt = 1) {
  const MAX_RESTARTS = 10;
  const RESTART_DELAY_MS = 5000;

  const isProduction = process.env.NODE_ENV === "production";

  // In production: dist/worker.js (built by esbuild)
  // In development: server/worker.ts (run by tsx)
  const workerScript = isProduction
    ? path.join(process.cwd(), "dist", "worker.js")
    : path.join(process.cwd(), "server", "worker.ts");

  const cmd = isProduction ? "node" : "tsx";
  const args = [workerScript];

  console.log(
    `[Worker Launcher] Starting worker (attempt ${attempt}/${MAX_RESTARTS}): ${cmd} ${workerScript}`,
  );

  const child = spawn(cmd, args, {
    stdio: "inherit", // Share stdout/stderr — worker logs appear in Railway
    env: process.env,
  });

  child.on("exit", (code, signal) => {
    if (code === 0) {
      console.log(`[Worker Launcher] Worker exited cleanly`);
      return;
    }
    console.error(`[Worker Launcher] Worker exited with code=${code} signal=${signal}`);
    if (attempt < MAX_RESTARTS) {
      console.log(`[Worker Launcher] Restarting worker in ${RESTART_DELAY_MS}ms...`);
      setTimeout(() => spawnWorker(attempt + 1), RESTART_DELAY_MS);
    } else {
      console.error(`[Worker Launcher] Worker failed ${MAX_RESTARTS} times — giving up. Check logs above.`);
    }
  });

  child.on("error", (err) => {
    console.error(`[Worker Launcher] Failed to spawn worker: ${err.message}`);
    if (attempt < MAX_RESTARTS) {
      setTimeout(() => spawnWorker(attempt + 1), RESTART_DELAY_MS);
    }
  });
}

if (process.env.DISABLE_WORKER !== "true") {
  // Small delay to let the HTTP server bind its port first
  setTimeout(() => spawnWorker(), 2000);
}
