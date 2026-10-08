-- Oversized rows cut short (2026-10-08, Persistence-and-Recovery → Size caps): a reason
-- that was a tool's whole output (3 MB), a Silk entry holding a diff stat of
-- thousands of files (1.5 MB) froze the screens that read them. SQL can't
-- write the originals to <data>/archive/, so this marks the work and the
-- daemon does it once at its next start (db/upkeep.ts), then removes the mark.
INSERT INTO `settings` (`key`, `value`) VALUES ('upkeep.clipOversizedRows', '"pending"')
  ON CONFLICT (`key`) DO NOTHING;
