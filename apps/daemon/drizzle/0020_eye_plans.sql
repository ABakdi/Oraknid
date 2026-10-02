CREATE TABLE `eye_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`pair_id` text NOT NULL,
	`call` text NOT NULL,
	`role` text NOT NULL,
	`model` text NOT NULL,
	`plan` text,
	`error` text,
	`ms` integer NOT NULL,
	`first_try` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `eye_plans_job` ON `eye_plans` (`job_id`);