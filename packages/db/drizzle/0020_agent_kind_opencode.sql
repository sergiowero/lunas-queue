PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`phase` text NOT NULL,
	`agent_kind` text NOT NULL,
	`model` text,
	`profile_id` text,
	`model_index` integer,
	`model_failed` integer DEFAULT false NOT NULL,
	`iteration` integer DEFAULT 0 NOT NULL,
	`herdr_workspace` text,
	`herdr_pane` text,
	`herdr_name` text,
	`agent_session` text,
	`agent_session_source` text,
	`run_token` text NOT NULL,
	`started_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`launched_at` integer,
	`ended_at` integer,
	`result` text,
	`failure_reason` text,
	`handoff` text,
	`context_read_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `agent_profiles`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "runs_phase_enum" CHECK("__new_runs"."phase" in ('refine', 'implement', 'verify', 'deliver')),
	CONSTRAINT "runs_agent_kind_enum" CHECK("__new_runs"."agent_kind" in ('claude', 'copilot', 'codex', 'opencode')),
	CONSTRAINT "runs_result_enum" CHECK("__new_runs"."result" in ('success', 'failure', 'cancelled')),
	CONSTRAINT "runs_agent_session_source_enum" CHECK("__new_runs"."agent_session_source" in ('native', 'herdr', 'name')),
	CONSTRAINT "runs_iteration_unsigned" CHECK(typeof("__new_runs"."iteration") = 'integer' and "__new_runs"."iteration" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_runs`("id", "task_id", "phase", "agent_kind", "model", "profile_id", "model_index", "model_failed", "iteration", "herdr_workspace", "herdr_pane", "herdr_name", "agent_session", "agent_session_source", "run_token", "started_at", "launched_at", "ended_at", "result", "failure_reason", "handoff", "context_read_at") SELECT "id", "task_id", "phase", "agent_kind", "model", "profile_id", "model_index", "model_failed", "iteration", "herdr_workspace", "herdr_pane", "herdr_name", "agent_session", "agent_session_source", "run_token", "started_at", "launched_at", "ended_at", "result", "failure_reason", "handoff", "context_read_at" FROM `runs`;--> statement-breakpoint
DROP TABLE `runs`;--> statement-breakpoint
ALTER TABLE `__new_runs` RENAME TO `runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `runs_run_token_unique` ON `runs` (`run_token`);--> statement-breakpoint
CREATE INDEX `runs_task_idx` ON `runs` (`task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `runs_one_active_per_task` ON `runs` (`task_id`) WHERE "runs"."ended_at" is null;