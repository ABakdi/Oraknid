ALTER TABLE `jobs` ADD `allow_rules` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `deny_rules` text DEFAULT '[]' NOT NULL;