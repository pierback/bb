ALTER TABLE `threads` ADD `creation_operation_id` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `creation_operation_fingerprint` text;--> statement-breakpoint
CREATE UNIQUE INDEX `threads_source_creation_operation_idx` ON `threads` (`source_thread_id`,`creation_operation_id`);