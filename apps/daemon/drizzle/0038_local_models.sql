CREATE TABLE `local_models` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`repo` text NOT NULL,
	`file` text NOT NULL,
	`name` text NOT NULL,
	`runner` text NOT NULL,
	`state` text NOT NULL,
	`error` text,
	`path` text,
	`parts` text DEFAULT '[]' NOT NULL,
	`projector` text,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`done_bytes` integer DEFAULT 0 NOT NULL,
	`quant` text,
	`kinds` text DEFAULT '[]' NOT NULL,
	`license` text,
	`context_length` integer,
	`layers` integer,
	`settings` text DEFAULT '{}' NOT NULL,
	`tokens_per_sec` real,
	`tool_calls` text,
	`last_used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_models_name_unique` ON `local_models` (`name`);