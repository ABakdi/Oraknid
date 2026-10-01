CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`public_key` text NOT NULL,
	`paired_at` integer NOT NULL,
	`last_seen_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE TABLE `events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`type` text NOT NULL,
	`topic` text NOT NULL,
	`job_id` text,
	`payload` text
);
--> statement-breakpoint
CREATE INDEX `events_topic_seq` ON `events` (`topic`,`seq`);--> statement-breakpoint
CREATE INDEX `events_job` ON `events` (`job_id`);--> statement-breakpoint
CREATE TABLE `inbox_items` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`job_id` text NOT NULL,
	`task_id` text,
	`raised_by` text NOT NULL,
	`title` text NOT NULL,
	`detail` text NOT NULL,
	`options` text NOT NULL,
	`default_option` text,
	`state` text NOT NULL,
	`answer` text,
	`answered_at` integer,
	`answered_by_device_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `inbox_state` ON `inbox_items` (`state`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`goal` text NOT NULL,
	`inputs` text NOT NULL,
	`skill_id` text NOT NULL,
	`skill_version` integer NOT NULL,
	`autonomy` text NOT NULL,
	`allowed_leg_ids` text NOT NULL,
	`budget` text NOT NULL,
	`state` text NOT NULL,
	`pause_reason` text,
	`blocked_reason` text,
	`web_version` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `jobs_project` ON `jobs` (`project_id`);--> statement-breakpoint
CREATE INDEX `jobs_state` ON `jobs` (`state`);--> statement-breakpoint
CREATE TABLE `leg_models` (
	`id` text PRIMARY KEY NOT NULL,
	`leg_id` text NOT NULL,
	`model` text NOT NULL,
	`display_name` text NOT NULL,
	`hidden` integer NOT NULL,
	`effort_levels` text NOT NULL,
	`quota` text NOT NULL,
	`profile` text NOT NULL,
	FOREIGN KEY (`leg_id`) REFERENCES `legs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `leg_models_leg_model` ON `leg_models` (`leg_id`,`model`);--> statement-breakpoint
CREATE TABLE `legs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`config` text NOT NULL,
	`secret_ref` text,
	`enabled` integer NOT NULL,
	`health` text NOT NULL,
	`quota` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `legs_name_unique` ON `legs` (`name`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`workspace_path` text NOT NULL,
	`is_git_repo` integer NOT NULL,
	`release_branch` text NOT NULL,
	`work_branch` text NOT NULL,
	`created_at` integer NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_workspace_path_unique` ON `projects` (`workspace_path`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `side_effects` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`task_id` text,
	`idempotency_key` text NOT NULL,
	`action` text NOT NULL,
	`payload` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `side_effects_idempotency_key_unique` ON `side_effects` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `silk_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`task_id` text,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`supersedes` text,
	`authored_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `silk_job_kind` ON `silk_entries` (`job_id`,`kind`);--> statement-breakpoint
CREATE TABLE `skills` (
	`id` text NOT NULL,
	`version` integer NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`source` text NOT NULL,
	`body` text NOT NULL,
	`interview` integer NOT NULL,
	`required_tools` text NOT NULL,
	`verify` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`id`, `version`)
);
--> statement-breakpoint
CREATE TABLE `steps` (
	`job_id` text NOT NULL,
	`step_key` text NOT NULL,
	`status` text NOT NULL,
	`input_hash` text NOT NULL,
	`output` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	PRIMARY KEY(`job_id`, `step_key`)
);
--> statement-breakpoint
CREATE TABLE `task_edges` (
	`task_id` text NOT NULL,
	`depends_on` text NOT NULL,
	PRIMARY KEY(`task_id`, `depends_on`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`depends_on`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`title` text NOT NULL,
	`instructions` text NOT NULL,
	`kind` text NOT NULL,
	`scope` text NOT NULL,
	`verify` text NOT NULL,
	`required_capabilities` text NOT NULL,
	`difficulty` text NOT NULL,
	`state` text NOT NULL,
	`assigned_leg_id` text,
	`assigned_model_id` text,
	`effort` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`budget` text,
	`lease_until` integer,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tasks_job` ON `tasks` (`job_id`);--> statement-breakpoint
CREATE INDEX `tasks_state` ON `tasks` (`state`);