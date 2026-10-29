-- Editada a mano, como 0002: drizzle-kit recrea `runs` y copia las columnas nuevas desde la versión
-- vieja, que no las tiene; además el DROP borraría en cascada los usage_records. ADD COLUMN con
-- CHECK basta y conserva las filas; el snapshot sigue igual al esquema.
ALTER TABLE `projects` ADD `herdr_workspace_id` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `agent_session_source` text CONSTRAINT "runs_agent_session_source_enum" CHECK("agent_session_source" in ('native', 'herdr', 'name'));--> statement-breakpoint
ALTER TABLE `runs` ADD `launched_at` integer;
