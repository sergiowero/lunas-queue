CREATE TABLE `task_instructions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`phase` text NOT NULL,
	`text` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "task_instructions_phase_enum" CHECK("task_instructions"."phase" in ('refine', 'implement', 'verify')),
	CONSTRAINT "task_instructions_text_not_empty" CHECK(length("task_instructions"."text") > 0)
);
--> statement-breakpoint
CREATE INDEX `task_instructions_task_idx` ON `task_instructions` (`task_id`);