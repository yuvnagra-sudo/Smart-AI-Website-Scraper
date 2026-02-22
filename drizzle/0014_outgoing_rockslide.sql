CREATE TABLE `processedFirms` (
	`id` int AUTO_INCREMENT NOT NULL,
	`jobId` int NOT NULL,
	`firmName` text NOT NULL,
	`firmUrl` text,
	`status` enum('processing','completed','failed') NOT NULL DEFAULT 'processing',
	`teamMembersFound` int DEFAULT 0,
	`errorMessage` text,
	`processedAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	CONSTRAINT `processedFirms_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `jobId_idx` ON `processedFirms` (`jobId`);--> statement-breakpoint
CREATE INDEX `jobId_firmName_idx` ON `processedFirms` (`jobId`,`firmName`);