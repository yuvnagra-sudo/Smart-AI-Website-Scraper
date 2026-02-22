ALTER TABLE `enrichmentJobs` ADD `tierFilter` enum('tier1','tier1-2','all') DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE `enrichmentJobs` ADD `currentFirmName` text;--> statement-breakpoint
ALTER TABLE `enrichmentJobs` ADD `currentTeamMemberCount` int DEFAULT 0;