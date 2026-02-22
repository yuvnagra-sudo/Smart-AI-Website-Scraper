ALTER TABLE `enrichmentJobs` ADD `deepTeamProfileScraping` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `enrichmentJobs` ADD `maxTeamProfiles` int DEFAULT 200 NOT NULL;