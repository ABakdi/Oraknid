ALTER TABLE `jobs` ADD `blocked_until` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `verify_round` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `step_up` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `avoid` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `escalation` integer DEFAULT 0 NOT NULL;