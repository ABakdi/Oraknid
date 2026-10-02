CREATE TABLE `tools` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`command` text NOT NULL,
	`args` text NOT NULL,
	`secret_names` text NOT NULL,
	`env` text NOT NULL,
	`reads` text NOT NULL,
	`sends` text NOT NULL,
	`untrusted` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tools_name_unique` ON `tools` (`name`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `tools` text DEFAULT '[]' NOT NULL;