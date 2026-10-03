ALTER TABLE `jobs` ADD `repos` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `server_roles` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `repos` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `commits` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
-- A project of one repo: that repo, its branches, and its GitHub link moved into it (ADR-042).
UPDATE `projects` SET `repos` = json_array(json_object(
  'name', replace(`workspace_path`, rtrim(`workspace_path`, replace(`workspace_path`, '/', '')), ''),
  'folder', '',
  'releaseBranch', `release_branch`,
  'workBranch', `work_branch`,
  'github', json(`github`)
)) WHERE `is_git_repo` = 1 AND `shadow` = 0;
