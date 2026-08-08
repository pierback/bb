CREATE TABLE `environment_thread_tabs` (
	`environment_id` text PRIMARY KEY NOT NULL,
	`thread_ids_json` text NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
