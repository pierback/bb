# Session Fabric

Status: integrated into the durable [agentic workspace](./agentic-workspace.md)
through the backend, host daemon, typed SDK, CLI, and worktree conversation
tabs. Automatic fallback remains out of scope.

Session Fabric lets bb discover provider-native conversations without claiming
ownership of them, bind only runtimes it can positively identify, audit model
changes, and continue work into a new provider through a fenced two-phase
cutover.

The governing rule is:

> Discovery is read-only evidence. Mutation requires an exact live runtime
> incarnation, a current control epoch, and a host-enforced mutation policy.

## Component architecture

```text
App / CLI / typed SDK / API clients
          |
          v
+--------------------------- bb server ----------------------------+
| Session Fabric                                                 |
|                                                                 |
| discovery catalog  lineage graph  command/model ledger          |
| handoff coordinator  capsule/review/auth evidence  audit API     |
+-------------------------------+---------------------------------+
                                | typed host RPC
                                v
+------------------------ bb host daemon --------------------------+
| Runtime Broker                                                  |
|                                                                 |
| live-incarnation checks  controlEpoch CAS  local mutation fence  |
| workspace reconciliation  provider discovery/runtime adapters    |
+-------------------------------+---------------------------------+
                                |
                +---------------+----------------+
                |               |                |
             Codex          Claude Code          Pi
          app-server       SDK bridge         SDK bridge
                |
        Cursor / custom agents through a bb-launched ACP process
```

ACP is an edge connector. It does not replace the canonical bb model, and an
ACP capability does not prove that an editor-owned or terminal-owned process is
safe to control.

The implementation follows the existing package boundaries:

- `@bb/domain` owns identity, lifecycle, guard, capsule, and transition rules.
- `@bb/db` owns durable lineage, commands, receipts, model epochs, handoff
  evidence, compare-and-swap updates, and migrations.
- `@bb/host-daemon-contract` owns the typed server-to-host protocol.
- `@bb/agent-runtime` owns provider adapters and provider-native discovery.
- `apps/host-daemon` owns the Runtime Broker, local fencing, runtime
  incarnation checks, workspace inspection, and isolated restatement.
- `apps/server` owns authorization, durable orchestration, public routes, and
  audit responses.
- `@bb/sdk` and `bb session` expose the same typed, fenced public workflow to
  applications, humans, and automation.

## Independent authorities

Session Fabric keeps four authorities separate because none implies another:

| Authority    | Source of truth                                                               | What it does not prove                                     |
| ------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Conversation | Provider-native session/transcript store                                      | A live controllable process exists                         |
| Runtime      | Exact process or endpoint incarnation                                         | The workspace is settled or exclusive                      |
| Workspace    | Host-observed worktree, files, background work, and declared external effects | The destination has the right context or spending approval |
| Intent       | bb lineage, commands, review, policy, and authorization records               | A provider accepted a mutation                             |

bb never edits or fabricates provider-native transcripts. Cross-provider
continuation creates a new native conversation and a lineage edge.

## Canonical graph

```text
Workstream
  `-- WorkstreamBranch
        |-- activeBindingId (compare-and-swap)
        `-- ExecutionBinding
              |-- NativeConversation
              |-- RuntimeInstance
              |-- RuntimeRecipe
              |-- WorkspaceState
              |-- ModelEpoch[]
              `-- Command[] -> lifecycle events + MutationReceipt

HandoffTransition
  |-- source ExecutionBinding
  |-- destination ExecutionBinding
  |-- source settlement + workspace snapshot
  |-- sealed ContextCapsule
  |-- user review + billing/permission authorization
  |-- destination restatement evidence
  `-- append-only lifecycle events
```

Important identities are deliberately non-interchangeable:

- `NativeConversation` is keyed by host, provider, provider instance, and
  provider-native conversation ID.
- `RuntimeInstance` is one immutable incarnation identified by runtime ID,
  boot nonce, endpoint fingerprint, provider instance, and start time. A PID is
  never sufficient identity.
- `ExecutionBinding` connects one branch to one native conversation, runtime,
  recipe, and workspace checkpoint for a bounded interval.
- `ModelEpoch` records requested and observed-effective model/account evidence
  for accepted changes.

Ownership and runtime phase are separate axes. Discovery begins as
`unfenced_external`; only exact inspection and broker binding can establish a
controllable ownership class. `outcome_unknown` is durable and blocks mutation.
It never permits speculative replay: only an exact handoff stage, restatement,
enable, or cleanup operation with matching durable identity and broker evidence
may return or finish its deterministic result.

## Mutation path

Every Session Fabric mutation follows the same safety kernel:

1. Persist a command or transition before host dispatch.
2. Resolve the exact binding, runtime incarnation, provider instance, phase,
   turn/cursor evidence, and control epoch.
3. Ask the host broker to authorize that complete guard.
4. Move the broker to `dispatching` before sending the provider request.
5. Persist the provider receipt and lifecycle event.
6. Treat transport loss after possible dispatch as `outcome_unknown`, unless
   an exact handoff operation has a matching persisted broker receipt or
   checkpoint that makes completion deterministic.

The control epoch increments whenever control authority changes. Stale commands
therefore fail even if a PID, endpoint path, thread ID, or native conversation
ID is reused.

The Runtime Broker also prevents two enabled bindings from mutating the same
workspace. A staged handoff destination remains `staged_read_only` until the
active-binding swap and the exact workspace digest gate have succeeded.

The broker persists control state, provider thread and process evidence,
restatement receipts, recovery receipts, and terminal tombstones in
`session-fabric/runtime-broker-v1.json`. A daemon restart therefore does not
erase the fences that determine who may mutate a workspace.

## Supported operations

### Worktree conversation connection

Each worktree conversation tab can project the exact provider-native
conversation currently bound to its bb thread. The tab shows both identities;
an unbound live thread offers an explicit **Connect** action.

`POST /api/v1/session-fabric/threads/:threadId/connection` reads the provider
thread ID already recorded by bb, discovers that exact conversation on the
environment host using the environment's exact worktree path, and runs the
staged adoption flow. It fails closed when the conversation is absent,
ambiguous, owned by another provider instance, or no longer backed by the
thread's live runtime. It does not attach arbitrary terminal- or editor-owned
sessions.

The resulting projection is available from:

- `GET /api/v1/session-fabric/threads/:threadId/connection`
- `GET /api/v1/session-fabric/environments/:environmentId/connections`
- `bb session status <thread-id>`
- `bb session connect <thread-id>`

### Read-only discovery

`POST /api/v1/session-fabric/discovery/scan` asks the selected host to scan its
provider instances and maps provider-reported working directories to requested
project roots. Provider adapters return metadata and evidence only; prompt,
message, preview, and transcript fields are not projected into the catalog.

Discovery support never implies attachability. Each result starts as
unfenced/observe-only evidence.

### Runtime adoption

`POST /api/v1/session-fabric/native-conversations/:catalogConversationId/adopt`
requires a corresponding live provider runtime already hosted by the target bb
thread and environment. The server inspects the runtime, records its immutable
incarnation and workspace/recipe evidence, binds it read-only, then enables it
with a control-epoch transition. Arbitrary external processes are not adopted.

### Audited model change

`POST /api/v1/session-fabric/bindings/:bindingId/model` changes only the model
of the
same provider on an idle, enabled, broker-controlled binding. The provider must
acknowledge the native reconfiguration request. Rejection is recorded as
`not_accepted`; ambiguous transport or provider termination is recorded as
`outcome_unknown`. Only an accepted receipt opens a new `ModelEpoch`.

`GET /api/v1/session-fabric/commands/:commandId` returns the command, ordered
lifecycle events, receipt, and resulting model epoch.

### Cross-provider continuation

Continuation is a new conversation and binding, not an in-place provider swap.
The public MVP uses the source worktree and therefore requires an enforceable
source fence.

```text
requested
  -> target_preflight
  -> source_ingress_frozen
  -> source_quiescing
  -> source_reconciling
  -> workspace_snapshot_captured
  -> capsule_built
  -> user_reviewed
  -> billing_and_permission_authorized
  -> destination_staging_read_only
  -> destination_staged_read_only
  -> destination_restating
  -> destination_restated_and_verified
  -> active_binding_swapped
  -> destination_enabling
  -> destination_mutation_enabled
  -> source_retired_or_detached
```

Prepare
(`POST /api/v1/session-fabric/bindings/:sourceBindingId/handoffs`) freezes
ingress, fences the exact source incarnation, verifies it is settled, captures
workspace state, and seals a content-hashed capsule. Settlement fails if there
are accepted queued messages, unresolved interactions, active tools, provider
retry/compaction, partial edits, active or unknown background resources,
unknown external effects, or an unknown outcome.

Activate (`POST /api/v1/session-fabric/handoffs/:transitionId/activate`) binds
user review and fresh billing/permission evidence to the capsule hash and
target. Supported destination bridges start in an isolated execution overlay
that exposes no mutation tools. The coordinator verifies an exact structured
restatement, compares the workspace digest, swaps the active binding with a
database CAS, and only then removes the overlay. Retirement terminalizes and
stops the old source runtime.

Abort (`POST /api/v1/session-fabric/handoffs/:transitionId/abort`) is allowed
only before the active-binding swap. It first terminalizes and stops the staged
destination, then restores the source through an exact incarnation/epoch
transition. After the swap, the coordinator never re-enables the source because
that could create two writers.

`GET /api/v1/session-fabric/handoffs/:transitionId` returns the complete
transition, event log, settlement, capsule, review, authorization, and
restatement audit.

## Crash and retry semantics

| Failure point                                                                                                  | Durable behavior                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before provider/host dispatch                                                                                  | Safe rejection or retry with the same idempotency identity                                                                                                                         |
| Model change after possible dispatch                                                                           | `outcome_unknown`; no automatic retry                                                                                                                                              |
| Destination stage, restatement, enable, or cleanup response lost                                               | The exact transition, binding, capsule, and request identity may use a persisted broker receipt or checkpoint to return or finish the deterministic result; mismatches fail closed |
| Handoff outcome has no exact durable evidence                                                                  | The in-progress phase remains blocked as ambiguous; the coordinator does not guess or dispatch a different operation                                                               |
| Failure before active-binding swap with known host outcomes                                                    | Abort discards the destination, then may restore the exact source at the next control epoch                                                                                        |
| Failure after active-binding swap                                                                              | Source stays fenced; repair proceeds forward only                                                                                                                                  |
| Repeated prepare/activate after completion                                                                     | Returns the same durable result only when request, capsule, review, permission, billing, and policy evidence still match                                                           |
| Daemon restart with exact, known-dead idle runtime                                                             | Recovery validates unchanged binding evidence, creates one new runtime incarnation, and increments the control epoch exactly once                                                  |
| Daemon restart while the process may be alive, identity is unknown, the binding is busy, or outcome is unknown | Recovery is refused                                                                                                                                                                |
| Daemon restart during an exact staged-destination operation                                                    | The persisted checkpoint or receipt resumes only that transition operation                                                                                                         |

The broker guarantees at most one bb dispatch. It does not claim provider-level
exactly-once behavior where the provider has no idempotency primitive.

For ordinary idle Fabric sends, the server performs recovery before queueing a
turn. Recovery is limited to a small set of missing-incarnation errors and
requires the host to prove that the exact recorded provider process is dead.
The host must reproduce the same thread, provider, configuration, workspace,
model, permission, and provider-conversation evidence. The server then commits
the new runtime incarnation and control epoch atomically; if later validation
or persistence fails, it stops the newly resumed runtime. Active turn steering
does not use this idle recovery path.

Host protocol version 86 is the hard cutover that includes runtime recovery and
terminal handoff cleanup commands. Server and daemon protocol versions must
match exactly.

## Provider capability matrix

| Provider family    | Discovery                                                             | Brokered runtime                        | Audited model reconfiguration | Handoff destination                                                                         |
| ------------------ | --------------------------------------------------------------------- | --------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------- |
| Codex              | Stable app-server `thread/list` metadata                              | bb-owned app-server process             | Provider-receipt gated        | Blocked: read-only workspace mode cannot prove all MCP/app/plugin side effects are disabled |
| Claude Code        | Stable Agent SDK session metadata                                     | bb-owned SDK bridge                     | Provider-receipt gated        | Supported with the isolated no-tools execution overlay                                      |
| Pi                 | Stable SDK/native JSONL metadata                                      | bb-owned SDK bridge                     | Provider-receipt gated        | Supported with the isolated no-tools execution overlay                                      |
| Cursor through ACP | Experimental, only when exact `session/list` capability is negotiated | bb-launched ACP process only            | Provider-receipt gated        | Blocked: ACP permission cooperation is not a complete mutation boundary                     |
| Custom ACP         | Experimental, only when exact `session/list` capability is negotiated | bb-launched, versioned ACP profile only | Provider-receipt gated        | Blocked by default for the same reason as Cursor                                            |

Any broker-controlled provider may be a handoff source once it can be fenced
and settled. Destination support is stricter because the imported capsule must
be restated while tools, memory, subagents, workflows, and workspace mutation
are provably disabled.

## Current scope limits

- The public handoff request currently accepts only `source_worktree`.
  `isolated_worktree` exists in the domain model but is not exposed until bb can
  provision and verify that destination atomically.
- There is no automatic provider fallback or budget-routing policy in this
  slice.
- Discovery does not attach to arbitrary terminal, desktop, or editor-owned
  sessions.
- Capsule transfer is structured and inspectable; full transcript replay,
  hidden reasoning, credentials, approvals, and live process handles are never
  transferred.
- Filesystem equality cannot prove external API, database, deploy, or payment
  side effects. Their status is explicit evidence and unknown status blocks the
  cutover.
- Billing/permission records audit a fresh authorization decision; they are not
  a universal provider-side hard spend cap.

## Code map

- Domain identities and graph: [`packages/domain/src/session-fabric-identity.ts`](../packages/domain/src/session-fabric-identity.ts)
- Command and runtime guards: [`packages/domain/src/session-fabric-control.ts`](../packages/domain/src/session-fabric-control.ts)
- Handoff lifecycle and capsule verification: [`packages/domain/src/session-fabric-transition.ts`](../packages/domain/src/session-fabric-transition.ts)
- Durable persistence: [`packages/db/src/data/session-fabric.ts`](../packages/db/src/data/session-fabric.ts)
- Host Runtime Broker: [`apps/host-daemon/src/session-runtime-broker.ts`](../apps/host-daemon/src/session-runtime-broker.ts)
- Host handoff commands: [`apps/host-daemon/src/command-handlers/session-fabric.ts`](../apps/host-daemon/src/command-handlers/session-fabric.ts)
- Durable handoff coordinator: [`apps/server/src/services/session-fabric/session-handoff-service.ts`](../apps/server/src/services/session-fabric/session-handoff-service.ts)
- Runtime recovery boundary: [`apps/server/src/services/session-fabric/session-runtime-recovery-service.ts`](../apps/server/src/services/session-fabric/session-runtime-recovery-service.ts)
- Public contract and routes: [`packages/server-contract/src/session-fabric.ts`](../packages/server-contract/src/session-fabric.ts), [`apps/server/src/routes/session-fabric.ts`](../apps/server/src/routes/session-fabric.ts)
- Typed SDK: [`packages/sdk/src/areas/session-fabric.ts`](../packages/sdk/src/areas/session-fabric.ts)
- CLI: [`apps/cli/src/commands/session.ts`](../apps/cli/src/commands/session.ts)
