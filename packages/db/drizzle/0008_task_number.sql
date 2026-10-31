-- Editada a mano, como 0004: drizzle-kit recrea `tasks` y el DROP borraría en cascada sus Runs,
-- aristas y usage. ADD COLUMN con CHECK conserva las filas; el snapshot sigue igual al esquema.
-- Drizzle no genera triggers ni el backfill (ADR 0015).
ALTER TABLE `tasks` ADD `number` integer CONSTRAINT "tasks_number_positive" CHECK("number" is null or (typeof("number") = 'integer' and "number" > 0));--> statement-breakpoint
UPDATE `tasks` SET `number` = (
  SELECT `n` FROM (
    SELECT `id`, row_number() OVER (ORDER BY `created_at`, rowid) AS `n` FROM `tasks`
  ) AS `ordered` WHERE `ordered`.`id` = `tasks`.`id`
);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_number_unique` ON `tasks` (`number`);--> statement-breakpoint
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
