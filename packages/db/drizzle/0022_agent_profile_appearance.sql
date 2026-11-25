-- Agent profiles get an icon and a color (ADR agent-profiles). The columns are added with a default so
-- the ALTER is valid; then every existing profile receives a random icon and a random color of the
-- sets PROFILE_ICONS and PROFILE_COLORS (@lunasq/schemas). Names and models are not touched.
ALTER TABLE `agent_profiles` ADD `icon` text DEFAULT 'bot' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_profiles` ADD `color` text DEFAULT 'blue' NOT NULL;--> statement-breakpoint
UPDATE `agent_profiles` SET
	`icon` = json_extract('["bot","sparkles","bolt","brain","rocket","wrench","shield","flask","compass","leaf"]', '$[' || (abs(random()) % 10) || ']'),
	`color` = json_extract('["red","orange","amber","green","teal","blue","violet","pink"]', '$[' || (abs(random()) % 8) || ']');
