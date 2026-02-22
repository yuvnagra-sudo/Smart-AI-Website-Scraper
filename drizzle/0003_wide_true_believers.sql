ALTER TABLE `enrichmentJobs` ADD `workerPid` int;--> statement-breakpoint
ALTER TABLE `enrichmentJobs` ADD `heartbeatAt` timestamp;--> statement-breakpoint
ALTER TABLE `enrichmentJobs` ADD `startedAt` timestamp;