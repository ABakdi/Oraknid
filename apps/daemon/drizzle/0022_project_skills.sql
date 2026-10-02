ALTER TABLE `jobs` ADD `skill_choices` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `skill_ids` text DEFAULT '[]' NOT NULL;