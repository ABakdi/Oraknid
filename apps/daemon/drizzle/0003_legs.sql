CREATE TABLE `attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`job_id` text NOT NULL,
	`leg_id` text NOT NULL,
	`leg_model_id` text NOT NULL,
	`effort` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`outcome` text,
	`escalations` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `attempts_task` ON `attempts` (`task_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text,
	`job_id` text,
	`task_id` text,
	`leg_id` text NOT NULL,
	`leg_model_id` text NOT NULL,
	`effort` text,
	`native_session_id` text,
	`pid` integer,
	`pid_start_time` integer,
	`log_file` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`end_reason` text,
	`end_error` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`context_tokens` integer,
	`usage_estimated` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_leg_started` ON `sessions` (`leg_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `sessions_open` ON `sessions` (`ended_at`);--> statement-breakpoint
ALTER TABLE `legs` ADD `paused` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `legs` ADD `health_detail` text;--> statement-breakpoint
ALTER TABLE `legs` ADD `limited_until` integer;--> statement-breakpoint
ALTER TABLE `legs` ADD `created_at` integer DEFAULT 0 NOT NULL;