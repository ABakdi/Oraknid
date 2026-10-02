CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`author` text NOT NULL,
	`text` text NOT NULL,
	`model` text,
	`error` text,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `chat_messages_chat` ON `chat_messages` (`chat_id`,`at`);--> statement-breakpoint
CREATE TABLE `chats` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`leg_id` text NOT NULL,
	`leg_model_id` text NOT NULL,
	`effort` text,
	`project_ids` text NOT NULL,
	`native_session_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
