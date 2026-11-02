-- Edited by hand, like 0002: drizzle-kit recreates `runs` and copies the new columns from the old
-- version, which does not have them; besides, the DROP would cascade-delete the usage_records. ADD COLUMN with
-- CHECK is enough and keeps the rows; the snapshot stays equal to the schema.
ALTER TABLE `projects` ADD `herdr_workspace_id` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `agent_session_source` text CONSTRAINT "runs_agent_session_source_enum" CHECK("agent_session_source" in ('native', 'herdr', 'name'));--> statement-breakpoint
ALTER TABLE `runs` ADD `launched_at` integer;
