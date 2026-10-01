ALTER TABLE `jobs` ADD `queued_at` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `priority` integer DEFAULT 0 NOT NULL;