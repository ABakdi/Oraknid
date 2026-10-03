ALTER TABLE `mail_accounts` DROP COLUMN `auth`;--> statement-breakpoint
DELETE FROM `settings` WHERE `key` LIKE 'mail.oauth.%';
