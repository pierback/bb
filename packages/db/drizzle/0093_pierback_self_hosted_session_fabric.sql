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
CREATE INDEX `environment_migrations_checkpoint_idx` ON `environment_migrations` (`checkpoint`);--> statement-breakpoint
CREATE TABLE `environment_preview_resources` (
	`environment_id` text PRIMARY KEY NOT NULL,
	`preview_resources_json` text NOT NULL,
	`selected_preview_resource_id` text,
	`revision` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `environment_thread_tabs` (
	`environment_id` text PRIMARY KEY NOT NULL,
	`thread_ids_json` text NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `session_fabric_adoptions` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`native_conversation_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`workstream_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`binding_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`native_conversation_id`) REFERENCES `session_fabric_native_conversations`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workstream_id`) REFERENCES `session_fabric_workstreams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`branch_id`) REFERENCES `session_fabric_branches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`binding_id`) REFERENCES `session_fabric_execution_bindings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_fabric_adoptions_idempotency_idx` ON `session_fabric_adoptions` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_fabric_adoptions_binding_idx` ON `session_fabric_adoptions` (`binding_id`);--> statement-breakpoint
CREATE INDEX `session_fabric_adoptions_thread_status_idx` ON `session_fabric_adoptions` (`thread_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `session_fabric_branches` (
	`id` text PRIMARY KEY NOT NULL,
	`workstream_id` text NOT NULL,
	`parent_branch_id` text,
	`status` text NOT NULL,
	`active_binding_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workstream_id`) REFERENCES `session_fabric_workstreams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_branch_id`) REFERENCES `session_fabric_branches`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`active_binding_id`) REFERENCES `session_fabric_execution_bindings`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `session_fabric_branches_workstream_status_idx` ON `session_fabric_branches` (`workstream_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `session_fabric_branches_parent_idx` ON `session_fabric_branches` (`parent_branch_id`);--> statement-breakpoint
CREATE TABLE `session_fabric_command_events` (
	`id` text PRIMARY KEY NOT NULL,
	`command_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`event` text NOT NULL,
	`from_status` text NOT NULL,
	`to_status` text NOT NULL,
	`occurred_at` integer NOT NULL,
	FOREIGN KEY (`command_id`) REFERENCES `session_fabric_commands`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_fabric_command_events_sequence_idx` ON `session_fabric_command_events` (`command_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `session_fabric_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`binding_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`payload_hash` text NOT NULL,
	`guard` text NOT NULL,
	`model_epoch_id` text,
	`receipt` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`binding_id`) REFERENCES `session_fabric_execution_bindings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`model_epoch_id`) REFERENCES `session_fabric_model_epochs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `session_fabric_commands_binding_status_idx` ON `session_fabric_commands` (`binding_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `session_fabric_context_capsules` (
	`id` text PRIMARY KEY NOT NULL,
	`transition_id` text NOT NULL,
	`expected_workspace_state_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`capsule` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`transition_id`) REFERENCES `session_fabric_handoff_transitions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`expected_workspace_state_id`) REFERENCES `session_fabric_workspace_states`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_fabric_context_capsules_transition_idx` ON `session_fabric_context_capsules` (`transition_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_fabric_context_capsules_hash_idx` ON `session_fabric_context_capsules` (`content_hash`);--> statement-breakpoint
CREATE TABLE `session_fabric_execution_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`workstream_branch_id` text NOT NULL,
	`thread_id` text,
	`native_conversation_id` text NOT NULL,
	`runtime_instance_id` text,
	`runtime_recipe_id` text NOT NULL,
	`workspace_state_id` text NOT NULL,
	`environment_id` text,
	`ownership` text NOT NULL,
	`mutation_policy` text NOT NULL,
	`phase` text NOT NULL,
	`control_epoch` integer NOT NULL,
	`native_cursor` text,
	`provider_turn_id` text,
	`opened_at` integer NOT NULL,
	`closed_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workstream_branch_id`) REFERENCES `session_fabric_branches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`native_conversation_id`) REFERENCES `session_fabric_native_conversations`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`runtime_instance_id`) REFERENCES `session_fabric_runtime_instances`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`runtime_recipe_id`) REFERENCES `session_fabric_runtime_recipes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workspace_state_id`) REFERENCES `session_fabric_workspace_states`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `session_fabric_bindings_branch_open_idx` ON `session_fabric_execution_bindings` (`workstream_branch_id`,`closed_at`,`opened_at`);--> statement-breakpoint
CREATE INDEX `session_fabric_bindings_runtime_idx` ON `session_fabric_execution_bindings` (`runtime_instance_id`,`closed_at`);--> statement-breakpoint
CREATE INDEX `session_fabric_bindings_thread_idx` ON `session_fabric_execution_bindings` (`thread_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_fabric_bindings_open_thread_idx` ON `session_fabric_execution_bindings` (`thread_id`) WHERE "session_fabric_execution_bindings"."thread_id" IS NOT NULL AND "session_fabric_execution_bindings"."closed_at" IS NULL;--> statement-breakpoint
CREATE TABLE `session_fabric_handoff_authorizations` (
	`id` text PRIMARY KEY NOT NULL,
	`transition_id` text NOT NULL,
	`capsule_content_hash` text NOT NULL,
	`destination_provider_instance_id` text NOT NULL,
	`destination_model` text NOT NULL,
	`billing_authorization_id` text,
	`billing_route_id` text NOT NULL,
	`permission_mode` text NOT NULL,
	`policy_version` integer NOT NULL,
	`authorized_at` integer NOT NULL,
	FOREIGN KEY (`transition_id`) REFERENCES `session_fabric_handoff_transitions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_fabric_handoff_authorizations_transition_idx` ON `session_fabric_handoff_authorizations` (`transition_id`);--> statement-breakpoint
CREATE TABLE `session_fabric_handoff_events` (
	`id` text PRIMARY KEY NOT NULL,
	`transition_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`event` text NOT NULL,
	`from_phase` text NOT NULL,
	`to_phase` text NOT NULL,
	`occurred_at` integer NOT NULL,
	FOREIGN KEY (`transition_id`) REFERENCES `session_fabric_handoff_transitions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_fabric_handoff_events_sequence_idx` ON `session_fabric_handoff_events` (`transition_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `session_fabric_handoff_restatements` (
	`id` text PRIMARY KEY NOT NULL,
	`transition_id` text NOT NULL,
	`destination_binding_id` text NOT NULL,
	`capsule_content_hash` text NOT NULL,
	`restatement` text NOT NULL,
	`observed_workspace_state_id` text NOT NULL,
	`verified_at` integer NOT NULL,
	FOREIGN KEY (`transition_id`) REFERENCES `session_fabric_handoff_transitions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`destination_binding_id`) REFERENCES `session_fabric_execution_bindings`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`observed_workspace_state_id`) REFERENCES `session_fabric_workspace_states`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_fabric_handoff_restatements_transition_idx` ON `session_fabric_handoff_restatements` (`transition_id`);--> statement-breakpoint
CREATE TABLE `session_fabric_handoff_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`transition_id` text NOT NULL,
	`capsule_content_hash` text NOT NULL,
	`reviewer_id` text NOT NULL,
	`reviewed_at` integer NOT NULL,
	FOREIGN KEY (`transition_id`) REFERENCES `session_fabric_handoff_transitions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_fabric_handoff_reviews_transition_idx` ON `session_fabric_handoff_reviews` (`transition_id`);--> statement-breakpoint
CREATE TABLE `session_fabric_handoff_source_settlements` (
	`id` text PRIMARY KEY NOT NULL,
	`transition_id` text NOT NULL,
	`source_workspace_state_id` text NOT NULL,
	`snapshot` text NOT NULL,
	`source_control_disposition` text NOT NULL,
	`captured_at` integer NOT NULL,
	FOREIGN KEY (`transition_id`) REFERENCES `session_fabric_handoff_transitions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_workspace_state_id`) REFERENCES `session_fabric_workspace_states`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_fabric_handoff_source_settlements_transition_idx` ON `session_fabric_handoff_source_settlements` (`transition_id`);--> statement-breakpoint
CREATE TABLE `session_fabric_handoff_transitions` (
	`id` text PRIMARY KEY NOT NULL,
	`workstream_branch_id` text NOT NULL,
	`kind` text NOT NULL,
	`phase` text NOT NULL,
	`source_binding_id` text NOT NULL,
	`destination_binding_id` text,
	`destination_environment_id` text NOT NULL,
	`source_provider_id` text NOT NULL,
	`destination_host_id` text NOT NULL,
	`destination_provider_id` text NOT NULL,
	`destination_provider_instance_id` text NOT NULL,
	`destination_model` text NOT NULL,
	`destination_reasoning_level` text NOT NULL,
	`destination_service_tier` text NOT NULL,
	`destination_thread_id` text NOT NULL,
	`destination_workspace_disposition` text NOT NULL,
	`source_control_disposition` text NOT NULL,
	`expected_workspace_state_id` text,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workstream_branch_id`) REFERENCES `session_fabric_branches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_binding_id`) REFERENCES `session_fabric_execution_bindings`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`destination_binding_id`) REFERENCES `session_fabric_execution_bindings`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`destination_environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`destination_host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`destination_thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`expected_workspace_state_id`) REFERENCES `session_fabric_workspace_states`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_fabric_handoff_transitions_open_branch_idx` ON `session_fabric_handoff_transitions` (`workstream_branch_id`) WHERE "session_fabric_handoff_transitions"."phase" NOT IN ('source_retired_or_detached', 'aborted');--> statement-breakpoint
CREATE INDEX `session_fabric_handoff_transitions_source_idx` ON `session_fabric_handoff_transitions` (`source_binding_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_fabric_handoff_transitions_idempotency_idx` ON `session_fabric_handoff_transitions` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `session_fabric_model_epochs` (
	`id` text PRIMARY KEY NOT NULL,
	`binding_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`requested_model` text NOT NULL,
	`effective_model` text,
	`effective_account` text,
	`billing_route_id` text NOT NULL,
	`reasoning_level` text NOT NULL,
	`service_tier` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`binding_id`) REFERENCES `session_fabric_execution_bindings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_fabric_model_epochs_sequence_idx` ON `session_fabric_model_epochs` (`binding_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_fabric_model_epochs_active_idx` ON `session_fabric_model_epochs` (`binding_id`) WHERE "session_fabric_model_epochs"."ended_at" IS NULL;--> statement-breakpoint
CREATE TABLE `session_fabric_native_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`project_id` text,
	`provider_id` text NOT NULL,
	`provider_instance_id` text NOT NULL,
	`native_conversation_id` text NOT NULL,
	`cwd` text,
	`title` text,
	`provider_state` text NOT NULL,
	`last_observed_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_fabric_native_conversations_native_idx` ON `session_fabric_native_conversations` (`host_id`,`provider_id`,`provider_instance_id`,`native_conversation_id`);--> statement-breakpoint
CREATE INDEX `session_fabric_native_conversations_project_idx` ON `session_fabric_native_conversations` (`project_id`,`last_observed_at`);--> statement-breakpoint
CREATE TABLE `session_fabric_runtime_instances` (
	`id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`provider_instance_id` text NOT NULL,
	`connector_id` text NOT NULL,
	`boot_nonce` text NOT NULL,
	`endpoint_fingerprint` text NOT NULL,
	`process_key` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`stopped_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_fabric_runtime_instances_incarnation_idx` ON `session_fabric_runtime_instances` (`host_id`,`provider_id`,`provider_instance_id`,`boot_nonce`,`endpoint_fingerprint`);--> statement-breakpoint
CREATE INDEX `session_fabric_runtime_instances_live_idx` ON `session_fabric_runtime_instances` (`host_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `session_fabric_runtime_recipes` (
	`id` text PRIMARY KEY NOT NULL,
	`cwd` text NOT NULL,
	`environment_fingerprint` text NOT NULL,
	`environment_reference_ids` text NOT NULL,
	`mcp_servers_fingerprint` text NOT NULL,
	`permission_mode` text NOT NULL,
	`plugins_fingerprint` text NOT NULL,
	`sandbox_profile` text NOT NULL,
	`tools_fingerprint` text NOT NULL,
	`workspace_write_roots` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_fabric_workspace_states` (
	`id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`worktree_id` text NOT NULL,
	`root_path` text NOT NULL,
	`head_sha` text,
	`digest_algorithm` text NOT NULL,
	`diff_digest` text NOT NULL,
	`index_digest` text NOT NULL,
	`untracked_manifest_digest` text NOT NULL,
	`watcher_generation` integer NOT NULL,
	`background_resources` text NOT NULL,
	`external_side_effect_status` text NOT NULL,
	`captured_at` integer NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_fabric_workspace_states_worktree_idx` ON `session_fabric_workspace_states` (`host_id`,`worktree_id`,`captured_at`);--> statement-breakpoint
CREATE TABLE `session_fabric_workstreams` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`objective` text NOT NULL,
	`status` text NOT NULL,
	`active_branch_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`active_branch_id`) REFERENCES `session_fabric_branches`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `session_fabric_workstreams_project_status_idx` ON `session_fabric_workstreams` (`project_id`,`status`,`updated_at`);--> statement-breakpoint
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
	`retire_requested_at` integer,
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
INSERT INTO `__new_environments`("id", "name", "project_id", "host_id", "path", "managed", "is_git_repo", "is_worktree", "branch_name", "base_branch", "default_branch", "merge_base_branch", "destroy_attempt_id", "retire_requested_at", "workspace_provision_type", "status", "created_at", "updated_at") SELECT "id", "name", "project_id", "host_id", "path", "managed", "is_git_repo", "is_worktree", "branch_name", "base_branch", "default_branch", "merge_base_branch", "destroy_attempt_id", "retire_requested_at", "workspace_provision_type", "status", "created_at", "updated_at" FROM `environments`;--> statement-breakpoint
DROP TABLE `environments`;--> statement-breakpoint
ALTER TABLE `__new_environments` RENAME TO `environments`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `environments_project_host_path_idx` ON `environments` (`project_id`,`host_id`,`path`);--> statement-breakpoint
CREATE INDEX `environments_host_path_lookup_idx` ON `environments` (`host_id`,`path`);--> statement-breakpoint
CREATE INDEX `environments_project_idx` ON `environments` (`project_id`);--> statement-breakpoint
CREATE INDEX `environments_parent_idx` ON `environments` (`parent_environment_id`);--> statement-breakpoint
CREATE INDEX `environments_status_idx` ON `environments` (`status`);
