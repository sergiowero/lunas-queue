CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
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
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `events_task_idx` ON `events` (`task_id`,`id`);--> statement-breakpoint
-- Reconstruir events borra sus triggers: se recrean los de append-only (migración 0001, ADR 0007).
CREATE TRIGGER `events_no_update` BEFORE UPDATE ON `events`
BEGIN
  SELECT RAISE(ABORT, 'events es append-only: no se puede modificar un evento');
END;
--> statement-breakpoint
CREATE TRIGGER `events_no_delete` BEFORE DELETE ON `events`
BEGIN
  SELECT RAISE(ABORT, 'events es append-only: no se puede borrar un evento');
END;
