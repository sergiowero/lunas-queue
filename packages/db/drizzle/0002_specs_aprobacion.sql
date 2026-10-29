-- Editada a mano: drizzle-kit recrea la tabla y copia created_by desde la versión vieja, que no
-- la tiene. ADD COLUMN con CHECK basta y conserva las filas; el snapshot sigue igual al esquema.
ALTER TABLE `specs` ADD `created_by` text DEFAULT 'agent' NOT NULL CONSTRAINT "specs_created_by_enum" CHECK("created_by" in ('human', 'agent', 'system'));--> statement-breakpoint
CREATE UNIQUE INDEX `specs_one_approved_per_task` ON `specs` (`task_id`) WHERE "specs"."approval" = 'approved';
