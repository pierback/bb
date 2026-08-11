# Session Fabric core, plugin, and deployment boundary

Status: accepted target architecture

This decision records the target packaging boundary for remote coordination and
Session Fabric. The integrated implementation remains the working checkpoint;
the split described here is an incremental extraction from that checkpoint, not
a parallel compatibility path.

The governing ownership rule is:

> BB core owns trusted execution and universally truthful state. The Session
> Fabric plugin owns optional orchestration and product surfaces. The remote PWA
> package owns deployment infrastructure only.

## Why the boundary is necessary

Coordinator selection and authentication happen before the desktop can load
plugins from that coordinator. Backend plugins run on the coordinator, and app
plugin bundles run in an unprivileged client surface. Neither can control the
Electron main-process lifecycle, add host-daemon command families, verify local
process identity, or establish machine credentials.

The current plugin host-control API can declare shared ports, while the public
SDK can perform ordinary host administration such as listing hosts and creating
join codes. Those are useful orchestration primitives, but they do not transfer
ownership of the execution trust boundary to a plugin.

The app plugin API also has settings, panels, actions, and an exclusive thread
list replacement, but it has no additive project-row metadata slot. Replacing
the complete thread list merely to show execution metadata would give an
optional plugin ownership of a universal safety signal.

## Target ownership

| Package boundary        | Owns                                                                                                                                                                                                                                                                                                     | Must not own                                                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BB core                 | Coordinator bootstrap and authentication; local execution-host lifecycle; enrollment credentials; host identity; runtime fencing and process identity; portable-session and worktree-migration semantics; canonical execution-location projection and badge; stable SDK and additive UI extension points | Session Fabric-specific workflow presentation or VPS deployment policy                                                                                           |
| `session-fabric` plugin | Workflow orchestration over public SDK primitives; audit and history UI; plugin CLI and settings; optional workspace/session views; supplementary project-row metadata                                                                                                                                   | Electron startup, coordinator choice, daemon protocol extensions, credentials, process probes, runtime authority, filesystem migration, or private server routes |
| PWA gateway deployment  | Built client artifact; Caddy; Authelia; FRP; service definitions; validation and release tooling                                                                                                                                                                                                         | BB coordination state, plugins, repositories, agent execution, or machine enrollment                                                                             |

The canonical execution-location badge remains in core. It answers where a
project will execute even when Session Fabric is disabled, unavailable, or
broken. A small additive project-row metadata slot may be added for plugin-owned
status adjacent to that badge.

## Dependency direction

```text
Desktop bootstrap and canonical app UI
                  |
                  v
       public BB API and typed SDK
          |                    |
          v                    v
trusted core use cases   Session Fabric plugin
          |
          v
domain policy + durable records
          |
          v
typed daemon protocol and host adapters

PWA gateway package -> published app artifact + public HTTP/WS surface
```

The plugin may depend on `@bb/plugin-sdk` and public `@bb/sdk` contracts. It
must not import `apps/server`, `apps/host-daemon`, database implementations, or
call `/internal` routes. Missing plugin capabilities are introduced as narrow,
upstreamable SDK use cases or additive UI slots rather than as general-purpose
desktop-main or daemon plugin systems.

## Extraction sequence

1. **Preserve the integrated checkpoint.** Keep the current implementation and
   its tests as the behavioral baseline.
2. **Name the core primitives.** Stabilize public contracts for discovery,
   connection, guarded model changes, handoff transitions, audit reads, and
   environment relocation. Keep all authority checks in core.
3. **Add only the required extension points.** Introduce an additive project-row
   metadata slot for supplementary plugin status. Do not move the canonical
   execution badge.
4. **Create the `session-fabric` plugin.** Move workflow composition, audit and
   history presentation, plugin CLI commands, settings, and optional views
   behind the public contracts.
5. **Delete duplicate core product surfaces.** Once the plugin owns a surface,
   remove the corresponding built-in workflow UI or CLI entry in the same hard
   cutover. Do not retain forwarding wrappers or legacy registrations.
6. **Make the gateway independently releasable.** Package the PWA artifact and
   `deploy/pwa-gateway` configuration with its own version, validation, release,
   and rollback procedure. It may remain in this repository initially, but it
   must not import or launch BB server or execution code.

## Acceptance criteria

- A desktop with all optional plugins disabled can select and authenticate to a
  remote coordinator while enrolling this Mac as the execution host.
- The coordinator stores chats and orchestration state; the selected host owns
  repositories, worktrees, terminals, builds, and provider execution.
- Runtime mutation still requires exact process identity, current control
  evidence, and a host-enforced fence.
- The canonical execution machine remains visible without Session Fabric.
- Disabling Session Fabric removes only its workflows and optional UI; it does
  not change execution authority or invalidate core state.
- Plugin code uses only public plugin/SDK contracts and can be tested with fake
  SDK adapters.
- The PWA gateway can be released and rolled back without shipping a BB server
  or host daemon to the VPS.
- Core, plugin, and deployment tests enforce their own boundaries.
- The extraction is a hard cutover. No backward-compatibility layer is added.

## Consequences

The near-term BB fork remains necessary because the trusted desktop and daemon
primitives do not fit the current plugin API. The fork can stay focused and
upstreamable: it provides the security kernel, coordinator/execution split, and
stable extension seams. Session Fabric can then evolve at plugin cadence, while
the PWA gateway can evolve at deployment cadence without widening either trust
boundary.
