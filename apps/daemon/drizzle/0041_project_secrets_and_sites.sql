CREATE TABLE `project_secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`environment` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_secrets_name` ON `project_secrets` (`project_id`,`environment`,`name`);--> statement-breakpoint
CREATE TABLE `site_checks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` text NOT NULL,
	`at` integer NOT NULL,
	`up` integer NOT NULL,
	`status` integer,
	`latency_ms` integer,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `site_checks_site` ON `site_checks` (`site_id`,`at`);--> statement-breakpoint
CREATE TABLE `sites` (
	`id` text PRIMARY KEY NOT NULL,
	`host` text NOT NULL,
	`url` text NOT NULL,
	`server_id` text,
	`source` text NOT NULL,
	`upstream` text,
	`hidden` integer DEFAULT false NOT NULL,
	`check_enabled` integer DEFAULT true NOT NULL,
	`interval_min` integer DEFAULT 5 NOT NULL,
	`last_check_at` integer,
	`up` integer,
	`fails` integer DEFAULT 0 NOT NULL,
	`down_since` integer,
	`dns` text,
	`dns_at` integer,
	`cert_expires_at` integer,
	`cert_issuer` text,
	`cert_names` text,
	`cert_valid` integer,
	`cert_error` text,
	`cert_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sites_host_unique` ON `sites` (`host`);