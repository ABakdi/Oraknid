CREATE INDEX `attempts_job` ON `attempts` (`job_id`);--> statement-breakpoint
CREATE INDEX `inbox_job` ON `inbox_items` (`job_id`);--> statement-breakpoint
CREATE INDEX `sessions_job` ON `sessions` (`job_id`);--> statement-breakpoint
CREATE INDEX `task_edges_depends` ON `task_edges` (`depends_on`);