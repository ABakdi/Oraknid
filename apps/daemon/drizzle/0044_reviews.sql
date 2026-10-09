-- Reviews (ADR-064, M16.1): a design or the running app annotated per device, in rounds; my notes.
CREATE TABLE `review_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`review_id` text NOT NULL,
	`round` integer NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`device` text,
	`element` text,
	`page` text,
	`screenshot` text,
	`console` text DEFAULT '[]' NOT NULL,
	`requests` text DEFAULT '[]' NOT NULL,
	`source` text DEFAULT 'page' NOT NULL,
	`author_device_id` text,
	`created_at` integer NOT NULL,
	`edited_at` integer,
	`deleted_at` integer,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `review_notes_review` ON `review_notes` (`review_id`,`round`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`task_id` text,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`target` text NOT NULL,
	`entry` text DEFAULT '/' NOT NULL,
	`round` integer DEFAULT 1 NOT NULL,
	`state` text NOT NULL,
	`frame_key` text NOT NULL,
	`inbox_item_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_frame_key_unique` ON `reviews` (`frame_key`);--> statement-breakpoint
CREATE INDEX `reviews_job` ON `reviews` (`job_id`);--> statement-breakpoint
CREATE INDEX `reviews_project` ON `reviews` (`project_id`,`state`);