CREATE TABLE `environment_migrations` (
	`id` text PRIMARY KEY NOT NULL,
	`environment_id` text NOT NULL,
	`source_host_id` text NOT NULL,
	`target_host_id` text NOT NULL,
	`stage` text NOT NULL,
	`checkpoint` text NOT NULL,
	`workspace_path` text NOT NULL,
	`workspace_provision_type` text NOT NULL,
	`provider_sessions_json` text NOT NULL,
	`manifest_json` text,
	`restored_workspace_json` text,
	`artifact_index` integer DEFAULT 0 NOT NULL,
	`artifact_offset` integer DEFAULT 0 NOT NULL,
	`bytes_transferred` integer DEFAULT 0 NOT NULL,
	`total_bytes` integer DEFAULT 0 NOT NULL,
	`error` text,
	`started_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`target_host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `environment_migrations_active_environment_idx` ON `environment_migrations` (`environment_id`) WHERE "environment_migrations"."completed_at" IS NULL;--> statement-breakpoint
CREATE INDEX `environment_migrations_source_host_idx` ON `environment_migrations` (`source_host_id`);--> statement-breakpoint
CREATE INDEX `environment_migrations_target_host_idx` ON `environment_migrations` (`target_host_id`);--> statement-breakpoint
CREATE INDEX `environment_migrations_checkpoint_idx` ON `environment_migrations` (`checkpoint`);