PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_eye_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text,
	`project_id` text DEFAULT '' NOT NULL,
	`author` text NOT NULL,
	`text` text NOT NULL,
	`action` text,
	`questions` text,
	`item_id` text,
	`answers` text,
	`reply_to` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_eye_messages`("id", "job_id", "project_id", "author", "text", "action", "questions", "item_id", "answers", "reply_to", "created_at") SELECT "id", "job_id", "project_id", "author", "text", "action", "questions", "item_id", "answers", "reply_to", "created_at" FROM `eye_messages`;--> statement-breakpoint
DROP TABLE `eye_messages`;--> statement-breakpoint
ALTER TABLE `__new_eye_messages` RENAME TO `eye_messages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `eye_messages_job` ON `eye_messages` (`job_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `eye_messages_project` ON `eye_messages` (`project_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `projects` ADD `server_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `projects_server_id_unique` ON `projects` (`server_id`);--> statement-breakpoint
ALTER TABLE `server_states` ADD `job_id` text;--> statement-breakpoint
ALTER TABLE `servers` ADD `production` integer DEFAULT false NOT NULL;