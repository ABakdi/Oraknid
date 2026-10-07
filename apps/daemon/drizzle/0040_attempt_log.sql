-- The attempt log (ADR-056 §1): append-only, typed, per attempt; deleted with its job.
CREATE TABLE `attempt_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`task_id` text NOT NULL,
	`attempt_id` text,
	`seq` integer NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `attempt_events_attempt` ON `attempt_events` (`attempt_id`,`seq`);--> statement-breakpoint
CREATE INDEX `attempt_events_task_kind` ON `attempt_events` (`task_id`,`kind`,`id`);--> statement-breakpoint
CREATE INDEX `attempt_events_job` ON `attempt_events` (`job_id`);