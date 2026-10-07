-- Mail accounts sign in by OAuth again (ADR-063): a password, or Google or Microsoft (XOAUTH2).
ALTER TABLE `mail_accounts` ADD `auth` text DEFAULT 'password' NOT NULL;