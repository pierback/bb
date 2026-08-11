---
kind: instruction
title: bb Guide — Provider Sessions
summary: Discover, adopt, mutate, hand off, and audit provider-native sessions through Session Fabric core and plugin commands.
intent: Keep agents on Session Fabric's fenced control path instead of mutating provider sessions directly.
editingNotes: Keep core commands aligned with apps/cli/src/commands/session.ts and plugin commands aligned with plugins/session-fabric/server.ts.
---
Provider session commands

Session Fabric discovers provider-native conversations without claiming control,
then gives adopted sessions one server-owned execution authority. Use these
commands instead of directly resuming or mutating an adopted provider session.

Install the optional official plugin before using the read, connect, and audit
commands. These commands have no core CLI aliases.

  bb plugin install session-fabric

  bb fabric status [thread-id] [--json]

  bb fabric connect [thread-id] [--json]

`status` projects the exact provider-native conversation currently bound to a
bb thread. `connect` uses the provider conversation ID already recorded by the
thread and the environment's exact worktree path, then performs staged,
fenced adoption. It fails when that live conversation cannot be identified
uniquely; it never attaches an arbitrary external process. Both commands use
the current BB thread when no thread ID is supplied.

  bb session discover --machine <id-or-name>
    [--project <id>]... [--include-unmapped] [--limit <1-200>]
    [--cursor <provider-id>:<provider-instance-id>:<cursor>]... [--json]

Discovery is read-only. Each cursor belongs to the exact provider and provider
instance printed by the previous result. `--host` is an alias for `--machine`.

  bb session adopt <catalog-conversation-id>
    --thread <thread-id> --title <title> --objective <objective>
    --idempotency-key <stable-16-to-200-character-key> [--json]

  bb session change-model <binding-id>
    --provider <provider-id> --model <model-id>
    --reasoning-level <level> --service-tier <fast|default> [--json]

  bb fabric command <command-id> [--json]

Adoption establishes the initial model epoch. Model changes run as audited,
fenced Session Fabric commands; generic thread updates cannot bypass that path.
Reuse the same idempotency key when retrying the same adoption operation.

  bb session handoff prepare <source-binding-id>
    --request-file <path> [--json]
  bb session handoff activate <transition-id>
    --capsule-hash <sha256:...> --reviewer <id> [--json]
  bb session handoff abort <transition-id> [--yes] [--json]
  bb fabric handoff <transition-id> [--json]

The prepare file is JSON matching the exported
`SessionFabricHandoffPrepareRequest` SDK type. It includes the complete capsule,
destination identity, destination model/reasoning/tier, source-worktree
disposition, and a stable idempotency key. The CLI validates the full schema
before sending it. The server still seals and scans the capsule, freezes and
settles the source, stages the destination read-only, and requires exact
destination restatement before it can swap and enable mutation authority.

Review the sealed capsule returned by `prepare`; pass that exact content hash to
`activate`. Activation is resumable after daemon or response loss and only
replays operations whose durable identity and receipts match exactly. Abort is
allowed only before the active-binding swap; it discards the staged destination
before restoring source mutation authority. `bb fabric handoff` returns the
transition, capsule, lifecycle events, review, authorization, settlement, and
restatement evidence.

Every listed leaf command supports `--json`. Never infer success from a lost
response: inspect the command or handoff audit record and retry with the
original identity.
