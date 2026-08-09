# Agentic workspace

bb's agentic workspace is one durable product model, not a collection of
thread-local IDE features. A project groups work; an environment owns a
workspace and its shared chat tabs; a thread owns one conversation; and Session
Fabric controls which exact provider runtime may mutate that workspace.

This is a hard-cutover architecture. The server, host daemon, public contract,
SDK, CLI, app, and database migration chain must be deployed from the same
version. There are no compatibility shims for older wire or persistence shapes.

## Integrated architecture

```text
React app            bb CLI             typed @bb/sdk clients
    \                  |                         /
     +---------------- public API --------------+
                              |
                    bb server application layer
              policy, orchestration, projections, CAS
                    /                         \
          durable SQLite state          realtime notifications
                    |
             typed host-daemon RPC
                    |
              enrolled execution host
       Git/filesystem effects + Runtime Broker
                    |
       provider-native conversation and runtime
```

The layers have deliberately narrow ownership:

| Layer            | Owns                                                                                         | Must not own                                     |
| ---------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| App, CLI, SDK    | User intent, presentation, typed request translation                                         | Authority, migration, update, or transfer policy |
| Server services  | Product policy and multi-step orchestration                                                  | Host-local filesystem or process implementation  |
| Domain           | Pure lifecycle, fencing, and freshness invariants                                            | I/O                                              |
| Database         | Durable records, compare-and-swap updates, checkpoints, epochs, and projections' source data | Provider or Git effects                          |
| Host daemon      | Git, filesystem transfer, provider bridges, runtime inspection, and local fences             | Global product authority                         |
| Shared contracts | Serializable API and daemon wire types                                                       | Application or infrastructure behavior           |

The principal identities remain distinct:

- A **project** groups sources, environments, threads, and a manager projection.
- An **environment** is the stable workspace identity. It owns its host,
  checkout, nesting metadata, ordered chat tabs, and freshness state.
- A **thread** is a conversation view and execution history attached to an
  environment; multiple threads may share one environment.
- A Session Fabric **execution binding** connects a workstream branch to one
  provider-native conversation and one exact runtime incarnation.
- A **host** is an enrolled execution machine. Browser clients are control
  surfaces and do not become execution hosts merely by opening bb.

Environment identity survives a host move. Provider-native conversation
identity survives only where the provider adapter can export and restore it
with explicit evidence. Session Fabric lineage records a new conversation when
continuation cannot preserve native identity.

## Session Fabric execution authority

Session Fabric is the execution-authority layer for agent runtimes. Discovery
is read-only evidence; it never grants mutation rights. Mutation requires an
exact live runtime incarnation, the current control epoch, a matching provider
instance, and a host-enforced fence. A stale epoch or ambiguous outcome fails
closed.

Provider handoff and environment migration are related but different:

- A **Session Fabric handoff** continues a workstream into a newly staged
  provider binding. It freezes the source, captures a sealed context capsule,
  requires review and authorization, verifies a no-tools restatement, swaps the
  active binding with compare-and-swap, enables the destination, and retires the
  source.
- An **environment migration** moves the workspace and portable provider
  session artifacts to another enrolled host. It retains the environment,
  thread, tab, manager, and preview identities while changing host authority.

Both workflows allow only one writer. Neither copies hidden reasoning,
credentials, approvals, arbitrary external process state, or fabricated
provider transcripts. See [Session Fabric](./session-fabric.md) for its graph,
guard kernel, provider capability matrix, and handoff audit model.

## Environment workspace

### Shared chat tabs

An environment persists one ordered set of open chat IDs. Every connected app
sees the same order, while active selection remains pane-local. Opening a
sidebar thread adds it to the set. Closing a tab removes only the view; it does
not archive or delete the thread.

Each tab also projects its Session Fabric connection as
`bb thread -> provider-native conversation`. For a live unbound thread, the
**Connect** action discovers only the exact provider conversation ID already
recorded by that thread in the environment's exact worktree, then establishes
the fenced binding. Missing or ambiguous evidence is rejected.

```bash
bb thread list --environment <environment-id>
bb environment tabs list <environment-id>
bb environment tabs open <environment-id> <thread-id>
bb environment tabs close <environment-id> <thread-id>
bb session status <thread-id>
bb session connect <thread-id>
```

### Nested managed environments

A nested managed environment is created from its parent's committed `HEAD`,
on the same host. bb stores both `parentEnvironmentId` and the parent base
commit, renders the relationship as an environment tree, and directs child
completion back to the parent branch instead of project main. A dirty parent is
reported before creation; uncommitted parent state is never silently copied.

```bash
bb thread spawn \
  --project <project-id> \
  --new-environment worktree \
  --parent-environment <parent-environment-id> \
  --prompt "Implement the nested slice"
```

### Source freshness

Freshness compares the environment branch with its resolved source branch and
reports current, ahead, behind, or diverged state with commit evidence. The
server may update automatically only when the environment is clean and every
attached agent is idle. Dirty, active, or otherwise unsafe work remains intact
and receives a blocked manual action rather than a speculative update.

```bash
bb environment freshness <environment-id>
bb environment update-source <environment-id>
```

Updates use the strategy returned by the policy (`fast_forward`, `rebase`, or
`none`). A Git conflict or an unavailable host is surfaced as state; bb does not
discard local changes to force freshness.

### Transcript-free manager projection

The project manager view is a read-only operational projection. It aggregates
environment lifecycle, thread/runtime status, pending interactions, worktree
changes, pull requests, and freshness without loading raw conversation
transcripts. Each dimension is isolated so one unavailable host or failed Git
probe does not erase the rest of the project overview.

The same contract powers the responsive app dashboard, SDK clients, and CLI:

```bash
bb project manager <project-id>
```

## Restart-safe host migration

Start and inspect a move through the same typed API exposed by the SDK:

```bash
bb environment move <environment-id> --host <target-host-id>
bb environment move-status <migration-id>
```

The server creates a durable migration record before dispatch. Its acknowledged
checkpoints are:

```text
created -> source_fenced -> source_prepared -> target_started
        -> artifacts_transferred -> target_restored
        -> authority_cutover -> cleanup_completed
```

Transfer progress, the artifact cursor, restored workspace evidence, errors,
and rollback state are persisted. On restart, the server enumerates incomplete
records and resumes from durable evidence rather than from an in-memory task.
The source host remains fenced throughout; host epochs reject stale commands.

Before authority cutover, a known failure can enter `rollback_pending` and
restore the source. After the atomic environment/host cutover, repair proceeds
forward and the old source is never re-enabled speculatively. Managed
environments remain managed after restoration, including their provision type,
branch semantics, parent relationship, and lifecycle cleanup behavior.

### Transfer allowlist

Tracked files and non-ignored untracked files are included automatically.
Ignored files are excluded unless an exact path appears in the regular
workspace file `.bb/environment-transfer.json`:

```json
{
  "version": 1,
  "includeIgnoredFiles": ["fixtures/local-cache.bin"]
}
```

The manifest is intentionally strict:

- Paths are unique POSIX-relative file or symlink paths. Directories, globs,
  absolute paths, traversal, Git internals, and non-ignored entries are rejected.
- Every allowlisted entry must exist. An absent manifest means no ignored files
  are transferred.
- A symlink must use a portable relative target, resolve to an existing path
  inside the workspace, and have no symlink ancestor. The target host validates
  the boundary again before restoration.
- Contents and modes are hashed and verified during transfer.

Ignore rules are never treated as permission to copy secrets. If an operator
explicitly allowlists a credential, that is an inspectable repository policy
decision; bb does not infer it and does not copy credentials from provider or
machine state. Prefer the secure secret-entry flow and host-local setup for
credentials and dependencies.

## Safety policy

| Risk                                | Enforced policy                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| Split-brain agent writers           | Exact runtime identity, monotonic control epochs, host fences, and CAS authority swaps        |
| Restart during migration or handoff | Durable checkpoints and receipts; ambiguous outcomes block rather than replay                 |
| Unsafe workspace transfer           | Explicit ignored-file manifest, path confinement, digest checks, and target-side revalidation |
| Parent work copied accidentally     | Nested environments use committed parent `HEAD`; dirty state is only warned about             |
| Source update destroys work         | Automatic and manual updates require policy eligibility; local work is never reset away       |
| Manager leaks conversation content  | Projection uses operational records and excludes raw transcripts                              |
| Old client or daemon shape          | Hard protocol cutover; mismatched versions are rejected                                       |

Database migrations are forward-only. Roll back behavior with a normal commit
revert and correct persistence with a new migration; never delete an applied
migration or hand-edit a generated Drizzle snapshot.

## Operational limits

- Session Fabric does not automatically choose providers by cost or budget and
  does not attach to arbitrary terminal-, editor-, or desktop-owned sessions.
- Cross-provider handoff support is capability-gated. A provider may be a safe
  source while remaining an unsafe destination if no-tools restatement cannot
  be proven.
- Environment migration copies portable workspace and supported provider
  session artifacts. It does not move live processes, dependency directories,
  external side effects, or opaque machine state; host-local setup must recreate
  them.
- A storage-only NAS can be a Git remote or artifact store, but it is not an
  execution target unless it runs an enrolled host daemon and agent provider.
- Filesystem equality cannot prove the state of external APIs, databases,
  deployments, or payments. Unknown external effects block Session Fabric
  cutover.

## Code map

- Session Fabric contract: [`packages/server-contract/src/session-fabric.ts`](../packages/server-contract/src/session-fabric.ts)
- Session Fabric orchestration: [`apps/server/src/services/session-fabric`](../apps/server/src/services/session-fabric)
- Runtime Broker: [`apps/host-daemon/src/session-runtime-broker.ts`](../apps/host-daemon/src/session-runtime-broker.ts)
- Migration repository: [`packages/db/src/data/environment-migrations.ts`](../packages/db/src/data/environment-migrations.ts)
- Migration orchestration: [`apps/server/src/services/environments/environment-migrations.ts`](../apps/server/src/services/environments/environment-migrations.ts)
- Transfer implementation: [`apps/host-daemon/src/command-handlers/environment-migration.ts`](../apps/host-daemon/src/command-handlers/environment-migration.ts)
- Environment API contract: [`packages/server-contract/src/api/environments.ts`](../packages/server-contract/src/api/environments.ts)
- Manager projection contract: [`packages/server-contract/src/api/projects.ts`](../packages/server-contract/src/api/projects.ts)
- Typed environment SDK: [`packages/sdk/src/areas/environments.ts`](../packages/sdk/src/areas/environments.ts)
