CREATE TABLE `cloud_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`remote` text NOT NULL,
	`root` text NOT NULL,
	`info` text NOT NULL,
	`limit_bytes` integer,
	`unlimited` integer DEFAULT false NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`used_bytes` integer,
	`free_bytes` integer,
	`total_bytes` integer,
	`checked_at` integer,
	`error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cloud_providers_remote_unique` ON `cloud_providers` (`remote`);