-- Event log append-only (ADR 0007): Drizzle no genera triggers, por eso esta migración es custom.
CREATE TRIGGER `events_no_update` BEFORE UPDATE ON `events`
BEGIN
  SELECT RAISE(ABORT, 'events es append-only: no se puede modificar un evento');
END;
--> statement-breakpoint
CREATE TRIGGER `events_no_delete` BEFORE DELETE ON `events`
BEGIN
  SELECT RAISE(ABORT, 'events es append-only: no se puede borrar un evento');
END;
