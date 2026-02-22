CREATE TABLE `enrichedFirms` (
	`id` int AUTO_INCREMENT NOT NULL,
	`jobId` int NOT NULL,
	`companyName` text NOT NULL,
	`websiteUrl` text,
	`description` text,
	`websiteVerified` varchar(10),
	`verificationMessage` text,
	`investorType` text,
	`investorTypeConfidence` int,
	`investorTypeSourceUrl` text,
	`investmentStages` text,
	`investmentStagesConfidence` int,
	`investmentStagesSourceUrl` text,
	`investmentNiches` text,
	`nichesConfidence` int,
	`nichesSourceUrl` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `enrichedFirms_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `teamMembers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`jobId` int NOT NULL,
	`firmId` int NOT NULL,
	`vcFirm` text NOT NULL,
	`name` text NOT NULL,
	`title` text,
	`jobFunction` text,
	`specialization` text,
	`linkedinUrl` text,
	`dataSourceUrl` text,
	`confidenceScore` int,
	`decisionMakerTier` varchar(20),
	`tierPriority` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `teamMembers_id` PRIMARY KEY(`id`)
);
