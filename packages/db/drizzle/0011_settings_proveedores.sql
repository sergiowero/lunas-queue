CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
-- Drizzle runs the migration inside a transaction, where PRAGMA foreign_keys has no effect:
-- if foreign keys are active, DROP TABLE events fires the ON DELETE CASCADE of outbox.
-- The outbox is backed up and restored; migrateDatabase turns them off and then the rows are still there,
-- which is why the restore ignores the ones that already exist.
CREATE TABLE `__outbox_backup` AS SELECT * FROM `outbox`;--> statement-breakpoint
CREATE TABLE `__new_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text,
	`type` text NOT NULL,
	`actor` text NOT NULL,
	`payload` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "events_actor_enum" CHECK("__new_events"."actor" in ('human', 'agent', 'system'))
);
--> statement-breakpoint
INSERT INTO `__new_events`("id", "task_id", "type", "actor", "payload", "created_at") SELECT "id", "task_id", "type", "actor", "payload", "created_at" FROM `events`;--> statement-breakpoint
DROP TABLE `events`;--> statement-breakpoint
ALTER TABLE `__new_events` RENAME TO `events`;--> statement-breakpoint
INSERT OR IGNORE INTO `outbox` SELECT * FROM `__outbox_backup`;--> statement-breakpoint
DROP TABLE `__outbox_backup`;--> statement-breakpoint
CREATE INDEX `events_task_idx` ON `events` (`task_id`,`id`);--> statement-breakpoint
-- Rebuilding events drops its triggers: the append-only ones are recreated (migration 0001, ADR 0007).
CREATE TRIGGER `events_no_update` BEFORE UPDATE ON `events`
BEGIN
  SELECT RAISE(ABORT, 'events es append-only: no se puede modificar un evento');
END;
--> statement-breakpoint
CREATE TRIGGER `events_no_delete` BEFORE DELETE ON `events`
BEGIN
  SELECT RAISE(ABORT, 'events es append-only: no se puede borrar un evento');
END;
