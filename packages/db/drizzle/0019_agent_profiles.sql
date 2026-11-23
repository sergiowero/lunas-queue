-- Agent profiles with model fallbacks replace the per-phase provider configuration (ADR agent-profiles).
-- The former provider, model, effort and args of every phase are dropped: each phase of every project
-- ends up unassigned (null) and no profile is created; the human assigns one. Re-running leaves the same state.
CREATE TABLE `agent_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`models` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_profiles_name_unique` ON `agent_profiles` (`name`);--> statement-breakpoint
ALTER TABLE `runs` ADD `profile_id` text REFERENCES agent_profiles(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `runs` ADD `model_index` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `model_failed` integer DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE `projects` SET `agent_profiles` = '{"refine":null,"implement":null,"verify":null,"deliver":null}';
