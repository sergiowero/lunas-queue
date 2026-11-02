-- Edited by hand: drizzle-kit recreates the table and copies created_by from the old version, which does not
-- have it. ADD COLUMN with CHECK is enough and keeps the rows; the snapshot stays equal to the schema.
ALTER TABLE `specs` ADD `created_by` text DEFAULT 'agent' NOT NULL CONSTRAINT "specs_created_by_enum" CHECK("created_by" in ('human', 'agent', 'system'));--> statement-breakpoint
CREATE UNIQUE INDEX `specs_one_approved_per_task` ON `specs` (`task_id`) WHERE "specs"."approval" = 'approved';
