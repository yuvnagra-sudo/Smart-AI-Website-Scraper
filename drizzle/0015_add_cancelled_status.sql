-- Add 'cancelled' to enrichmentJobs status enum
ALTER TABLE `enrichmentJobs` MODIFY COLUMN `status` enum('pending','processing','completed','failed','cancelled') NOT NULL DEFAULT 'pending';
