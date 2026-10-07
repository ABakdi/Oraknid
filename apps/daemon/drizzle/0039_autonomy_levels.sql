-- Auto mode (ADR-053): Standard becomes auto, Supervised becomes careful.
UPDATE `jobs` SET `autonomy` = 'auto' WHERE `autonomy` = 'standard';--> statement-breakpoint
UPDATE `jobs` SET `autonomy` = 'careful' WHERE `autonomy` = 'supervised';
