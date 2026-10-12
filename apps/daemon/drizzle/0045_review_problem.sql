-- The app didn't start (ADR-069 §5): the review shows why and what was tried, with Try again;
-- and the devices Oraknid saw it render at before showing it (§4).
ALTER TABLE `reviews` ADD `problem` text;--> statement-breakpoint
ALTER TABLE `reviews` ADD `checked` text;