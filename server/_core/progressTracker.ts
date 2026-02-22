/**
 * Real-Time Progress Tracker
 * Broadcasts job progress updates via WebSocket
 */

import { WebSocket, WebSocketServer } from "ws";

export interface ProgressUpdate {
  jobId: number;
  currentFirm: string;
  firmIndex: number;
  totalFirms: number;
  teamMembersFound: number;
  estimatedTimeRemaining: number; // seconds
  status: "processing" | "completed" | "failed";
  message?: string;
}

class ProgressTracker {
  private wss: WebSocketServer | null = null;
  private clients: Map<number, Set<WebSocket>> = new Map(); // jobId -> Set of WebSocket clients
  private jobStartTimes: Map<number, number> = new Map(); // jobId -> start timestamp

  /**
   * Initialize WebSocket server
   */
  initialize(server: any) {
    this.wss = new WebSocketServer({ server, path: "/api/progress" });

    this.wss.on("connection", (ws, req) => {
      console.log("[Progress Tracker] New WebSocket connection");

      ws.on("message", (message) => {
        try {
          const data = JSON.parse(message.toString());
          
          if (data.type === "subscribe" && data.jobId) {
            this.subscribeToJob(data.jobId, ws);
            console.log(`[Progress Tracker] Client subscribed to job ${data.jobId}`);
          }
        } catch (error) {
          console.error("[Progress Tracker] Error handling message:", error);
        }
      });

      ws.on("close", () => {
        this.unsubscribeClient(ws);
        console.log("[Progress Tracker] Client disconnected");
      });
    });

    console.log("[Progress Tracker] WebSocket server initialized");
  }

  /**
   * Subscribe a client to job updates
   */
  private subscribeToJob(jobId: number, ws: WebSocket) {
    if (!this.clients.has(jobId)) {
      this.clients.set(jobId, new Set());
    }
    this.clients.get(jobId)!.add(ws);
  }

  /**
   * Unsubscribe a client from all jobs
   */
  private unsubscribeClient(ws: WebSocket) {
    this.clients.forEach((clients, jobId) => {
      clients.delete(ws);
      if (clients.size === 0) {
        this.clients.delete(jobId);
      }
    });
  }

  /**
   * Start tracking a job
   */
  startJob(jobId: number) {
    this.jobStartTimes.set(jobId, Date.now());
  }

  /**
   * Send progress update to all subscribed clients
   */
  sendProgress(update: ProgressUpdate) {
    const clients = this.clients.get(update.jobId);
    if (!clients || clients.size === 0) return;

    const message = JSON.stringify(update);
    
    clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    });

    console.log(`[Progress Tracker] Sent update for job ${update.jobId}: ${update.currentFirm} (${update.firmIndex}/${update.totalFirms})`);
  }

  /**
   * Calculate estimated time remaining
   */
  estimateTimeRemaining(jobId: number, firmIndex: number, totalFirms: number): number {
    const startTime = this.jobStartTimes.get(jobId);
    if (!startTime || firmIndex === 0) return 0;

    const elapsed = (Date.now() - startTime) / 1000; // seconds
    const avgTimePerFirm = elapsed / firmIndex;
    const remaining = (totalFirms - firmIndex) * avgTimePerFirm;

    return Math.ceil(remaining);
  }

  /**
   * End job tracking
   */
  endJob(jobId: number) {
    this.jobStartTimes.delete(jobId);
    this.clients.delete(jobId);
  }
}

// Singleton instance
let progressTracker: ProgressTracker | null = null;

export function getProgressTracker(): ProgressTracker {
  if (!progressTracker) {
    progressTracker = new ProgressTracker();
  }
  return progressTracker;
}
