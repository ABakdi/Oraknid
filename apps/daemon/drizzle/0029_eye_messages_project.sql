ALTER TABLE `eye_messages` ADD `project_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `eye_messages` SET `project_id` = (SELECT `project_id` FROM `jobs` WHERE `jobs`.`id` = `eye_messages`.`job_id`);--> statement-breakpoint
CREATE INDEX `eye_messages_project` ON `eye_messages` (`project_id`,`created_at`);
