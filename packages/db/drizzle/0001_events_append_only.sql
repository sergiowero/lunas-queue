-- Append-only Event log (ADR 0007): Drizzle does not generate triggers, which is why this migration is custom.
CREATE TRIGGER `events_no_update` BEFORE UPDATE ON `events`
BEGIN
  SELECT RAISE(ABORT, 'events is append-only: an event cannot be modified');
END;
--> statement-breakpoint
CREATE TRIGGER `events_no_delete` BEFORE DELETE ON `events`
BEGIN
  SELECT RAISE(ABORT, 'events is append-only: an event cannot be deleted');
END;
