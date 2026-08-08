PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_environments` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`project_id` text NOT NULL,
	`host_id` text NOT NULL,
	`parent_environment_id` text,
	`parent_base_commit` text,
	`parent_had_uncommitted_changes` integer DEFAULT false NOT NULL,
	`path` text,
	`managed` integer DEFAULT false NOT NULL,
	`is_git_repo` integer DEFAULT false NOT NULL,
	`is_worktree` integer DEFAULT false NOT NULL,
	`branch_name` text,
	`base_branch` text,
	`default_branch` text,
	`merge_base_branch` text,
	`destroy_attempt_id` text,
	`workspace_provision_type` text NOT NULL,
	`status` text DEFAULT 'provisioning' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "environments_parent_shape_check" CHECK((
        (
          "__new_environments"."parent_environment_id" IS NULL
          AND "__new_environments"."parent_base_commit" IS NULL
          AND "__new_environments"."parent_had_uncommitted_changes" = 0
        )
        OR
        (
          "__new_environments"."parent_environment_id" IS NOT NULL
          AND "__new_environments"."parent_base_commit" IS NOT NULL
          AND "__new_environments"."managed" = 1
          AND "__new_environments"."workspace_provision_type" = 'managed-worktree'
        )
      ))
);
--> statement-breakpoint
INSERT INTO `__new_environments`("id", "name", "project_id", "host_id", "path", "managed", "is_git_repo", "is_worktree", "branch_name", "base_branch", "default_branch", "merge_base_branch", "destroy_attempt_id", "workspace_provision_type", "status", "created_at", "updated_at") SELECT "id", "name", "project_id", "host_id", "path", "managed", "is_git_repo", "is_worktree", "branch_name", "base_branch", "default_branch", "merge_base_branch", "destroy_attempt_id", "workspace_provision_type", "status", "created_at", "updated_at" FROM `environments`;--> statement-breakpoint
DROP TABLE `environments`;--> statement-breakpoint
ALTER TABLE `__new_environments` RENAME TO `environments`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `environments_project_host_path_idx` ON `environments` (`project_id`,`host_id`,`path`);--> statement-breakpoint
CREATE INDEX `environments_host_path_lookup_idx` ON `environments` (`host_id`,`path`);--> statement-breakpoint
CREATE INDEX `environments_project_idx` ON `environments` (`project_id`);--> statement-breakpoint
CREATE INDEX `environments_parent_idx` ON `environments` (`parent_environment_id`);--> statement-breakpoint
CREATE INDEX `environments_status_idx` ON `environments` (`status`);
