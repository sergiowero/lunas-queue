-- SQLite can add this checked, non-null column without rebuilding `specs`; existing versions become `code`.
ALTER TABLE `specs` ADD `deliverable` text DEFAULT 'code' NOT NULL CONSTRAINT "specs_deliverable_enum" CHECK("deliverable" in ('code', 'docs'));
