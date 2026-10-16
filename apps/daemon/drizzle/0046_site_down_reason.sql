-- A site is down only when it is down (ADR-071): why it is down (the site, the path from this
-- computer, or its server out of reach), when its failures in a row began, and when it last came
-- back (flap damping). A site down before this was said down: it stays so.
ALTER TABLE `sites` ADD `down_reason` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `failing_since` integer;--> statement-breakpoint
ALTER TABLE `sites` ADD `back_at` integer;--> statement-breakpoint
UPDATE `sites` SET `down_reason` = 'site' WHERE `down_since` IS NOT NULL;
