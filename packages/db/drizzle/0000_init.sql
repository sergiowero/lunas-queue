CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`type` text NOT NULL,
	`actor` text NOT NULL,
	`payload` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "events_actor_enum" CHECK("events"."actor" in ('human', 'agent', 'system'))
);
--> statement-breakpoint
CREATE INDEX `events_task_idx` ON `events` (`task_id`,`id`);--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`topic` text NOT NULL,
	`payload` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`published_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "outbox_attempts_unsigned" CHECK(typeof("outbox"."attempts") = 'integer' and "outbox"."attempts" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_event_id_unique` ON `outbox` (`event_id`);--> statement-breakpoint
CREATE INDEX `outbox_pending_idx` ON `outbox` (`id`) WHERE "outbox"."published_at" is null;--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`repo` text NOT NULL,
	`base_branch` text NOT NULL,
	`local_path` text NOT NULL,
	`agent_profiles` text DEFAULT '{}' NOT NULL,
	`limits` text DEFAULT '{}' NOT NULL,
	`test_command` text,
	`bootstrap` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_name_unique` ON `projects` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_local_path_unique` ON `projects` (`local_path`);--> statement-breakpoint
CREATE TABLE `questions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`run_id` text,
	`question` text NOT NULL,
	`context` text,
	`status` text DEFAULT 'open' NOT NULL,
	`answer` text,
	`answered_by` text,
	`answered_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "questions_status_enum" CHECK("questions"."status" in ('open', 'answered', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `questions_task_idx` ON `questions` (`task_id`);--> statement-breakpoint
CREATE INDEX `questions_run_idx` ON `questions` (`run_id`);--> statement-breakpoint
CREATE INDEX `questions_status_idx` ON `questions` (`status`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`phase` text NOT NULL,
	`agent_kind` text NOT NULL,
	`model` text,
	`iteration` integer DEFAULT 0 NOT NULL,
	`herdr_workspace` text,
	`herdr_pane` text,
	`herdr_name` text,
	`agent_session` text,
	`run_token` text NOT NULL,
	`started_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`ended_at` integer,
	`result` text,
	`failure_reason` text,
	`handoff` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "runs_phase_enum" CHECK("runs"."phase" in ('refine', 'implement', 'verify', 'deliver')),
	CONSTRAINT "runs_agent_kind_enum" CHECK("runs"."agent_kind" in ('claude')),
	CONSTRAINT "runs_result_enum" CHECK("runs"."result" in ('success', 'failure', 'cancelled')),
	CONSTRAINT "runs_iteration_unsigned" CHECK(typeof("runs"."iteration") = 'integer' and "runs"."iteration" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_run_token_unique` ON `runs` (`run_token`);--> statement-breakpoint
CREATE INDEX `runs_task_idx` ON `runs` (`task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `runs_one_active_per_task` ON `runs` (`task_id`) WHERE "runs"."ended_at" is null;--> statement-breakpoint
CREATE TABLE `specs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`version` integer NOT NULL,
	`domain_model` text,
	`requirements` text,
	`acceptance_criteria` text DEFAULT '[]' NOT NULL,
	`task_list` text,
	`approval` text DEFAULT 'pending' NOT NULL,
	`approved_by` text,
	`approved_at` integer,
	`review_comments` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "specs_version_positive" CHECK("specs"."version" >= 1),
	CONSTRAINT "specs_approval_enum" CHECK("specs"."approval" in ('pending', 'approved', 'changes_requested'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `specs_task_version_unique` ON `specs` (`task_id`,`version`);--> statement-breakpoint
CREATE TABLE `task_dependencies` (
	`task_id` text NOT NULL,
	`depends_on_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`task_id`, `depends_on_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`depends_on_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "task_dependencies_no_self_loop" CHECK("task_dependencies"."task_id" <> "task_dependencies"."depends_on_id")
);
--> statement-breakpoint
CREATE INDEX `task_dependencies_depends_on_idx` ON `task_dependencies` (`depends_on_id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`intent` text NOT NULL,
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
	CONSTRAINT "tasks_priority_unsigned" CHECK(typeof("tasks"."priority") = 'integer' and "tasks"."priority" between 0 and 9007199254740991),
	CONSTRAINT "tasks_verification_iteration_unsigned" CHECK(typeof("tasks"."verification_iteration") = 'integer' and "tasks"."verification_iteration" >= 0),
	CONSTRAINT "tasks_state_enum" CHECK("tasks"."state" in ('draft', 'refined', 'in_progress', 'verification', 'completed', 'needs_human', 'cancelled')),
	CONSTRAINT "tasks_sub_state_enum" CHECK("tasks"."sub_state" in ('queued', 'running', 'waiting_human')),
	CONSTRAINT "tasks_pr_state_enum" CHECK("tasks"."pr_state" in ('open', 'merged', 'closed')),
	CONSTRAINT "tasks_risk_label_enum" CHECK("tasks"."risk_label" in ('low', 'medium', 'high'))
);
--> statement-breakpoint
CREATE INDEX `tasks_project_idx` ON `tasks` (`project_id`);--> statement-breakpoint
CREATE INDEX `tasks_state_idx` ON `tasks` (`state`,`sub_state`);--> statement-breakpoint
CREATE TABLE `usage_records` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real,
	`source` text NOT NULL,
	`source_ref` text,
	`pricing_version` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "usage_records_input_tokens_unsigned" CHECK(typeof("usage_records"."input_tokens") = 'integer' and "usage_records"."input_tokens" >= 0),
	CONSTRAINT "usage_records_output_tokens_unsigned" CHECK(typeof("usage_records"."output_tokens") = 'integer' and "usage_records"."output_tokens" >= 0),
	CONSTRAINT "usage_records_cache_read_tokens_unsigned" CHECK(typeof("usage_records"."cache_read_tokens") = 'integer' and "usage_records"."cache_read_tokens" >= 0),
	CONSTRAINT "usage_records_cache_write_tokens_unsigned" CHECK(typeof("usage_records"."cache_write_tokens") = 'integer' and "usage_records"."cache_write_tokens" >= 0),
	CONSTRAINT "usage_records_cost_usd_nonneg" CHECK("usage_records"."cost_usd" >= 0),
	CONSTRAINT "usage_records_source_enum" CHECK("usage_records"."source" in ('otel', 'transcript', 'calculated'))
);
--> statement-breakpoint
CREATE INDEX `usage_records_run_idx` ON `usage_records` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `usage_records_source_ref_unique` ON `usage_records` (`run_id`,`source`,`source_ref`);