-- Task field `intent` renamed to `goal`. The events table is append-only (ADR 0007), so its
-- triggers are lifted only while the stored payloads are rewritten and then recreated as they were.
ALTER TABLE `tasks` RENAME COLUMN `intent` TO `goal`;
--> statement-breakpoint
DROP TRIGGER `events_no_update`;
--> statement-breakpoint
UPDATE `events`
SET `payload` = json_set(json_remove(`payload`, '$.intent'), '$.goal', json_extract(`payload`, '$.intent'))
WHERE `type` = 'task.created' AND json_type(`payload`, '$.intent') IS NOT NULL;
--> statement-breakpoint
UPDATE `events`
SET `payload` = json_set(
  `payload`,
  '$.from', json(CASE WHEN json_type(`payload`, '$.from.intent') IS NOT NULL
    THEN json_set(json_remove(json_extract(`payload`, '$.from'), '$.intent'), '$.goal', json_extract(`payload`, '$.from.intent'))
    ELSE json_extract(`payload`, '$.from') END),
  '$.to', json(CASE WHEN json_type(`payload`, '$.to.intent') IS NOT NULL
    THEN json_set(json_remove(json_extract(`payload`, '$.to'), '$.intent'), '$.goal', json_extract(`payload`, '$.to.intent'))
    ELSE json_extract(`payload`, '$.to') END)
)
WHERE `type` = 'task.updated'
  AND (json_type(`payload`, '$.from.intent') IS NOT NULL OR json_type(`payload`, '$.to.intent') IS NOT NULL);
--> statement-breakpoint
CREATE TRIGGER `events_no_update` BEFORE UPDATE ON `events`
BEGIN
  SELECT RAISE(ABORT, 'events es append-only: no se puede modificar un evento');
END;
