import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";

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
