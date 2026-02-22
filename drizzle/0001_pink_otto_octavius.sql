CREATE TABLE `enrichmentJobs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`status` enum('pending','processing','completed','failed') NOT NULL DEFAULT 'pending',
	`inputFileUrl` text NOT NULL,
	`inputFileKey` text NOT NULL,
	`outputFileUrl` text,
	`outputFileKey` text,
	`firmCount` int DEFAULT 0,
	`processedCount` int DEFAULT 0,
	`errorMessage` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`completedAt` timestamp,
	CONSTRAINT `enrichmentJobs_id` PRIMARY KEY(`id`)
);
