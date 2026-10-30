CREATE TABLE `run_subagents` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`agent_type` text NOT NULL,
	`started_at` integer,
	`stopped_at` integer,
	`transcript_path` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_subagents_run_agent_unique` ON `run_subagents` (`run_id`,`agent_id`);