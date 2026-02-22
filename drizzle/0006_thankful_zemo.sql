CREATE TABLE `investmentThesis` (
	`id` int AUTO_INCREMENT NOT NULL,
	`jobId` int NOT NULL,
	`firmId` int NOT NULL,
	`vcFirm` text NOT NULL,
	`websiteUrl` text,
	`investorType` text,
	`primaryFocusAreas` text,
	`emergingInterests` text,
	`preferredStages` text,
	`averageCheckSize` text,
	`recentInvestmentPace` text,
	`keyDecisionMakers` text,
	`totalTeamSize` int,
	`tier1Count` int,
	`tier2Count` int,
	`portfolioSize` int,
	`recentPortfolioCount` int,
	`talkingPoints` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `investmentThesis_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `portfolioCompanies` (
	`id` int AUTO_INCREMENT NOT NULL,
	`jobId` int NOT NULL,
	`firmId` int NOT NULL,
	`vcFirm` text NOT NULL,
	`portfolioCompany` text NOT NULL,
	`investmentDate` text,
	`websiteUrl` text,
	`investmentNiche` text,
	`dataSourceUrl` text,
	`confidenceScore` text,
	`recencyScore` int,
	`recencyCategory` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `portfolioCompanies_id` PRIMARY KEY(`id`)
);
