CREATE TABLE `eye_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`author` text NOT NULL,
	`text` text NOT NULL,
	`action` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `eye_messages_job` ON `eye_messages` (`job_id`,`created_at`);