-- Optional icon and color per project (docs/decisions/0008-config-proyecto.md). Existing projects end up with null in both.
ALTER TABLE `projects` ADD `icon` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `color` text;
