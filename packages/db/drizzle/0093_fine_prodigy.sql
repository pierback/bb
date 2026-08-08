CREATE TABLE `environment_preview_resources` (
	`environment_id` text PRIMARY KEY NOT NULL,
	`preview_resources_json` text NOT NULL,
	`selected_preview_resource_id` text,
	`revision` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
