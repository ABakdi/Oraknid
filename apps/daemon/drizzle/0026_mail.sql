CREATE TABLE `mail_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`provider` text NOT NULL,
	`auth` text NOT NULL,
	`login` text NOT NULL,
	`imap_host` text NOT NULL,
	`imap_port` integer NOT NULL,
	`imap_security` text NOT NULL,
	`smtp_host` text NOT NULL,
	`smtp_port` integer NOT NULL,
	`smtp_security` text NOT NULL,
	`auto_send` integer DEFAULT false NOT NULL,
	`append_sent` integer NOT NULL,
	`state` text DEFAULT 'new' NOT NULL,
	`error` text,
	`last_sync_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mail_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`to` text NOT NULL,
	`cc` text NOT NULL,
	`bcc` text NOT NULL,
	`subject` text NOT NULL,
	`html` text NOT NULL,
	`text` text NOT NULL,
	`reply_to_id` text,
	`forward_of_id` text,
	`thread_id` text,
	`attachments` text NOT NULL,
	`author` text NOT NULL,
	`job_id` text,
	`state` text DEFAULT 'draft' NOT NULL,
	`approval_item_id` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`sent_at` integer
);
--> statement-breakpoint
CREATE INDEX `mail_drafts_account` ON `mail_drafts` (`account_id`,`state`);--> statement-breakpoint
CREATE TABLE `mail_folders` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`path` text NOT NULL,
	`name` text NOT NULL,
	`special_use` text,
	`uid_validity` text,
	`last_uid` integer DEFAULT 0 NOT NULL,
	`synced_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mail_folders_path` ON `mail_folders` (`account_id`,`path`);--> statement-breakpoint
CREATE TABLE `mail_image_senders` (
	`account_id` text NOT NULL,
	`address` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`account_id`, `address`)
);
--> statement-breakpoint
CREATE TABLE `mail_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`folder_id` text NOT NULL,
	`uid` integer NOT NULL,
	`message_id` text,
	`in_reply_to` text,
	`references` text NOT NULL,
	`thread_id` text NOT NULL,
	`subject` text NOT NULL,
	`from_name` text NOT NULL,
	`from_address` text NOT NULL,
	`to` text NOT NULL,
	`cc` text NOT NULL,
	`reply_to` text NOT NULL,
	`date` integer NOT NULL,
	`flags` text NOT NULL,
	`size` integer NOT NULL,
	`has_attachments` integer NOT NULL,
	`snippet` text DEFAULT '' NOT NULL,
	`text` text,
	`html` text,
	`attachments` text,
	`images_allowed` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mail_messages_uid` ON `mail_messages` (`folder_id`,`uid`);--> statement-breakpoint
CREATE INDEX `mail_messages_folder_date` ON `mail_messages` (`folder_id`,`date`);--> statement-breakpoint
CREATE INDEX `mail_messages_thread` ON `mail_messages` (`account_id`,`thread_id`);--> statement-breakpoint
CREATE INDEX `mail_messages_message_id` ON `mail_messages` (`account_id`,`message_id`);