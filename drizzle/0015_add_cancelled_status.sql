-- Add 'cancelled' to enrichmentJobs status enum
-- This allows the cancelJob mutation to set status = 'cancelled' so the worker
-- can detect it via DB polling and stop processing promptly.
ALTER TABLE `enrichmentJobs` MODIFY COLUMN `status` enum('pending','processing','completed','failed','cancelled') NOT NULL DEFAULT 'pending';
