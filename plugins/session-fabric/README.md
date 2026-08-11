# Session Fabric

Session Fabric is BB's optional application layer for inspecting and operating
portable provider sessions. Install it from the plugin catalog, then open
**Session Fabric** from a thread's right-panel launcher or run `bb fabric`.

```bash
bb plugin install session-fabric
```

## Boundary

This plugin is a client of `bb.sdk.sessionFabric`. It owns presentation,
operator commands, and workflow-oriented orchestration. It does **not** own:

- coordinator selection or authentication;
- execution-host enrollment or daemon lifecycle;
- runtime fencing and process identity;
- portable-session or worktree-migration semantics; or
- the canonical project execution-location badge.

Those are trust and bootstrap primitives in BB core. The plugin must not import
server, host-daemon, or database implementations, and it must not call private
`/internal` routes.

## CLI

```text
bb fabric status [thread-id] [--json]
bb fabric connect [thread-id] [--json]
bb fabric command <command-id> [--json]
bb fabric handoff <transition-id> [--json]
```

`status` and `connect` use the current BB thread when the CLI supplies thread
context, otherwise they require an explicit thread id.

These read, connect, and audit commands moved from the core `bb session` CLI in
a hard cutover; no compatibility aliases remain. Trusted discovery, adoption,
model changes, and handoff mutations remain under `bb session` until their
complete workflows can move without transferring runtime authority to the
plugin.
