CREATE TABLE `server_samples` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_id` text NOT NULL,
	`at` integer NOT NULL,
	`sample` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `server_samples_server` ON `server_samples` (`server_id`,`at`);--> statement-breakpoint
CREATE TABLE `server_states` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`version` integer NOT NULL,
	`body` text NOT NULL,
	`source` text NOT NULL,
	`discovery` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `server_states_server` ON `server_states` (`server_id`,`version`);--> statement-breakpoint
CREATE TABLE `servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`host` text NOT NULL,
	`port` integer NOT NULL,
	`user` text NOT NULL,
	`description` text NOT NULL,
	`host_key` text,
	`host_key_offered` text,
	`auth` text NOT NULL,
	`setup` text DEFAULT 'new' NOT NULL,
	`monitor_hash` text,
	`last_seen_at` integer,
	`error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `projects` ADD `server_ids` text DEFAULT '[]' NOT NULL;