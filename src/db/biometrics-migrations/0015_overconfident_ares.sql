CREATE TABLE `reference_nights` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`side` text NOT NULL,
	`source` text NOT NULL,
	`device_model` text,
	`pod_version` text,
	`night_start` integer NOT NULL,
	`night_end` integer NOT NULL,
	`stages` text NOT NULL,
	`heart_rate` text NOT NULL,
	`hrv` text NOT NULL,
	`beat_series` text NOT NULL,
	`respiratory_rate` text NOT NULL,
	`clock_offset_ms` integer NOT NULL,
	`uploaded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_reference_nights_side_start` ON `reference_nights` (`side`,`night_start`);