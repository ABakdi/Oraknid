CREATE TABLE `silk_mirror` (
	`job_id` text NOT NULL,
	`file` text NOT NULL,
	`hash` text NOT NULL,
	`pending_item_id` text,
	PRIMARY KEY(`job_id`, `file`)
);
