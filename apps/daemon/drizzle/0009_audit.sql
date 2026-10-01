ALTER TABLE `events` ADD `actor` text DEFAULT 'oraknid' NOT NULL;--> statement-breakpoint
CREATE INDEX `events_type` ON `events` (`type`);