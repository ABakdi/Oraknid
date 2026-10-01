ALTER TABLE `jobs` ADD `worktree` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `branch` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `verify` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `unsandboxed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `waived` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `shadow` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `position` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `plan_key` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `routing` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `pinned_model_id` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `owner_held` integer DEFAULT false NOT NULL;