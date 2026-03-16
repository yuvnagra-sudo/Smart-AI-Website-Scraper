ALTER TABLE `enrichmentJobs` MODIFY COLUMN `status` enum('pending','processing','completed','failed','cancelled','paused') NOT NULL DEFAULT 'pending';
