-- Append-only Event log (ADR 0007): Drizzle does not generate triggers, which is why this migration is custom.
CREATE TRIGGER `events_no_update` BEFORE UPDATE ON `events`
BEGIN
  SELECT RAISE(ABORT, 'events es append-only: no se puede modificar un evento');
END;
--> statement-breakpoint
CREATE TRIGGER `events_no_delete` BEFORE DELETE ON `events`
BEGIN
  SELECT RAISE(ABORT, 'events es append-only: no se puede borrar un evento');
END;
