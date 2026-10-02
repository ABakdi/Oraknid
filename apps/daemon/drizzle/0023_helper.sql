CREATE TABLE `helper_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`author` text NOT NULL,
	`text` text NOT NULL,
	`actions` text NOT NULL,
	`at` integer NOT NULL
);
