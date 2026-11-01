-- Editada a mano: drizzle-kit recrea `tasks` para ampliar el CHECK de `state` (SQLite no altera un
-- CHECK) y no recrea los triggers de 0008, que se agregan al final. El DROP borraría en cascada
-- Runs, aristas, eventos y usage si las claves foráneas estuvieran activas: PRAGMA foreign_keys no
-- actúa dentro de la transacción de la migración, así que migrateDatabase las apaga antes y
-- verifica foreign_key_check después (client.ts). El snapshot sigue igual al esquema.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`number` integer,
	`project_id` text NOT NULL,
	`intent` text NOT NULL,
	`title` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`priority` integer NOT NULL,
	`state` text DEFAULT 'draft' NOT NULL,
	`sub_state` text DEFAULT 'queued',
	`verification_iteration` integer DEFAULT 0 NOT NULL,
	`branch` text,
	`worktree_path` text,
	`pr_url` text,
	`pr_state` text,
	`risk_label` text,
	`caused_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`caused_by`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "tasks_priority_unsigned" CHECK(typeof("__new_tasks"."priority") = 'integer' and "__new_tasks"."priority" between 0 and 9007199254740991),
	CONSTRAINT "tasks_verification_iteration_unsigned" CHECK(typeof("__new_tasks"."verification_iteration") = 'integer' and "__new_tasks"."verification_iteration" >= 0),
	CONSTRAINT "tasks_state_enum" CHECK("__new_tasks"."state" in ('draft', 'refined', 'in_progress', 'verification', 'completed', 'needs_human', 'paused', 'cancelled')),
	CONSTRAINT "tasks_sub_state_enum" CHECK("__new_tasks"."sub_state" in ('queued', 'running', 'waiting_human')),
	CONSTRAINT "tasks_pr_state_enum" CHECK("__new_tasks"."pr_state" in ('open', 'merged', 'closed')),
	CONSTRAINT "tasks_risk_label_enum" CHECK("__new_tasks"."risk_label" in ('low', 'medium', 'high')),
	CONSTRAINT "tasks_number_positive" CHECK("__new_tasks"."number" is null or (typeof("__new_tasks"."number") = 'integer' and "__new_tasks"."number" > 0))
);
--> statement-breakpoint
INSERT INTO `__new_tasks`("id", "number", "project_id", "intent", "title", "tags", "priority", "state", "sub_state", "verification_iteration", "branch", "worktree_path", "pr_url", "pr_state", "risk_label", "caused_by", "created_at", "updated_at") SELECT "id", "number", "project_id", "intent", "title", "tags", "priority", "state", "sub_state", "verification_iteration", "branch", "worktree_path", "pr_url", "pr_state", "risk_label", "caused_by", "created_at", "updated_at" FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_number_unique` ON `tasks` (`number`);--> statement-breakpoint
CREATE INDEX `tasks_project_idx` ON `tasks` (`project_id`);--> statement-breakpoint
CREATE INDEX `tasks_state_idx` ON `tasks` (`state`,`sub_state`);--> statement-breakpoint
CREATE TRIGGER `tasks_assign_number` AFTER INSERT ON `tasks` WHEN NEW.`number` IS NULL
BEGIN
  UPDATE `tasks` SET `number` = (SELECT coalesce(max(`number`), 0) + 1 FROM `tasks`)
  WHERE rowid = NEW.rowid;
END;
--> statement-breakpoint
CREATE TRIGGER `tasks_number_immutable` BEFORE UPDATE OF `number` ON `tasks`
WHEN OLD.`number` IS NOT NULL AND NEW.`number` IS NOT OLD.`number`
BEGIN
  SELECT RAISE(ABORT, 'el número de una tarea no cambia');
END;
