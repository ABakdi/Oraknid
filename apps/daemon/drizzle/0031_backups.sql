CREATE TABLE `backup_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`public_key` text NOT NULL,
	`imported` integer DEFAULT false NOT NULL,
	`exported_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `backup_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`server_id` text NOT NULL,
	`target` text NOT NULL,
	`schedule` text NOT NULL,
	`destination` text NOT NULL,
	`retention` text NOT NULL,
	`key_id` text,
	`enabled` integer DEFAULT true NOT NULL,
	`next_run_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `backup_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`state` text NOT NULL,
	`trigger` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`size` integer,
	`duration_ms` integer,
	`checksum` text,
	`destination` text NOT NULL,
	`path` text,
	`key_id` text,
	`error` text,
	`verified_at` integer,
	`verify_ok` integer,
	`verify_note` text,
	`pruned_at` integer
);
--> statement-breakpoint
CREATE INDEX `backup_runs_plan` ON `backup_runs` (`plan_id`,`started_at`);