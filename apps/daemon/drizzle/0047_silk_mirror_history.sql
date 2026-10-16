-- Oraknid's own state is not my edit (ADR-072): every version of a mirror file Oraknid wrote (the
-- last 50 hashes), so one git put back is rewritten unasked; the sets of edits I answered, never
-- asked again; and the set the open question is about. What Oraknid last wrote starts the list.
ALTER TABLE `silk_mirror` ADD `written` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `silk_mirror` ADD `answered` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `silk_mirror` ADD `pending_edits` text;--> statement-breakpoint
UPDATE `silk_mirror` SET `written` = json_array(`hash`) WHERE `hash` != '';
