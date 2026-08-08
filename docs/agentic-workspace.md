# Agentic workspace

This document turns bb's existing primitives into one coherent agentic IDE
workspace and records the intended follow-on work.

## Product shape

An environment is the stable workspace identity. It owns the worktree and the
ordered set of open chat tabs. A pane selects one active chat while keeping a
persistent right panel available for files, Markdown, HTML artifacts, diffs,
terminals, browser sessions, and plugin surfaces. The project sidebar shows the
environment tree and the threads that share each workspace.

The resulting shell has four coordinated regions:

1. Project and environment tree on the left.
2. Environment-scoped chat tabs across the top.
3. The active agent conversation in the center.
4. A persistent artifact/browser/editor panel on the right.

## Shipped foundation

- Managed worktrees provide isolated execution environments.
- Multiple threads can share one worktree.
- Environment chat tabs are ordered and persisted by the server. The active
  tab remains pane-local, and closing a tab never archives the thread.
- Thread listing can be scoped to an environment through the public API, SDK,
  CLI, and app.
- The right panel already supports files, rendered Markdown and HTML, diffs,
  terminals, browser surfaces, plugins, and side chats.
- Manager threads and parent/child threads provide the coordination primitive.
- bb connect, enrolled execution machines, and SSH editor mappings provide the
  remote-control foundation.
- Secret requests use bb's secure secret-entry flow rather than chat text.

## Decisions

- Opening a sidebar thread adds it to the shared environment tab set.
- Tabs have one server-persisted order per environment; active selection is
  local to the pane.
- A nested worktree starts from the parent worktree's committed `HEAD`. If the
  parent is dirty, bb warns before creation rather than silently copying
  uncommitted state.
- Completing nested work targets the parent worktree branch, not project main.
- Source freshness is safe-by-default: detect upstream changes continuously;
  automatically rebase only when the worktree is clean and every attached
  agent is idle; otherwise show a badge and a one-click update action.

## Follow-on slices

### Nested environments

Add `parentEnvironmentId` and the parent base commit to managed environments.
Provision the child on the same host from the parent's committed `HEAD`, render
the relationship as an expandable tree, and make merge/squash actions target
the parent branch. Server policy owns eligibility and lifecycle; the host
daemon continues to own git worktree operations.

### Source freshness

Track the resolved upstream ref and observed commit for each managed worktree.
The host reports changes; the server decides whether a clean, idle environment
may update automatically. Dirty or active environments retain their files and
surface behind/diverged state in the sidebar, tab strip, and manager summary.

### Project manager agent

Expose a project-level manager thread above the environment tree. Its context
is a compact server projection of environment status, attached thread status,
pending interactions, diffs, pull requests, and freshness—not raw transcripts.
The same projection must be available through the SDK and CLI so the manager is
not a UI-only special case.

### Host-to-host workspace handoff

Relocate an environment between enrolled machines that the user controls, such
as a Mac, VPS, or NAS. The bb server retains the thread identity, events, tab
state, panels, and manager state; the target host recreates the worktree and
resumes execution. Tracked and dirty git state can move through a dedicated bb
handoff ref or bundle, while untracked files follow an explicit project policy.
Processes and dependencies restart through host-local setup rather than being
copied as opaque machine state.

A machine is an execution target only when it can run the bb host daemon and
agent provider. A storage-only NAS can still serve as a git remote or artifact
store without pretending to be an execution host.

### Synchronized preview

Treat previews as environment resources rather than one-off chat attachments.
Detect app servers from host port events, bind the selected resource to the
environment, and keep it visible while users switch chat tabs. Native browser
surfaces remain preferred on the user's current machine; a remote execution
host can publish a noVNC-backed computer-use session through the same
right-panel resource contract.

## Remaining product decision

The untracked-file half of host-to-host handoff still needs an explicit default:
an allowlisted sync manifest, mirroring all ignored files, or host-local setup
only. The safe recommendation is an allowlisted manifest because it is
inspectable, portable, and does not silently transfer credentials or
machine-local state.
