CREATE TABLE `mail_pop_uidls` (
	`account_id` text NOT NULL,
	`uidl` text NOT NULL,
	`message_id` text,
	`delete_on_server` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`account_id`, `uidl`)
);
--> statement-breakpoint
CREATE INDEX `mail_pop_uidls_message` ON `mail_pop_uidls` (`message_id`);--> statement-breakpoint
ALTER TABLE `mail_accounts` ADD `protocol` text DEFAULT 'imap' NOT NULL;--> statement-breakpoint
ALTER TABLE `mail_accounts` ADD `delete_from_server` integer DEFAULT false NOT NULL;