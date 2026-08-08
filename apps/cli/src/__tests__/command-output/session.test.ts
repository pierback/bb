import { describe, expect, it, vi } from "vitest";
import {
  collectLogPayloads,
  getHelpOutput,
  runCommand,
  setupCommandOutputTestEnvironment,
  stubServerApi,
  type CommandRegistrar,
} from "../helpers/command-output-harness.js";
import { registerSessionCommands } from "../../commands/session.js";

describe("bb session command output", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerSessionCommands(program, () => "http://server");

  it("discovers native conversations on an explicitly resolved machine", async () => {
    const discover = vi.fn(async () => ({ catalogEntries: [], scans: [] }));
    stubServerApi({
      "v1.hosts.$get": vi.fn(async () => [
        {
          id: "host-remote",
          name: "builder",
          type: "persistent",
          status: "connected",
          maxPermissionMode: "full",
          lastSeenAt: 1,
          lastRejectedProtocolVersion: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
      "v1.session-fabric.discovery.scan.$post": discover,
    });

    await runCommand(
      [
        "session",
        "discover",
        "--machine",
        "builder",
        "--project",
        "proj-one",
        "--project",
        "proj-two",
        "--include-unmapped",
        "--limit",
        "50",
        "--cursor",
        "codex:codex-default:opaque:cursor",
        "--json",
      ],
      register,
    );

    expect(discover).toHaveBeenCalledWith({
      json: {
        hostId: "host-remote",
        includeUnmapped: true,
        limitPerProvider: 50,
        projectIds: ["proj-one", "proj-two"],
        providerCursors: [
          {
            providerId: "codex",
            providerInstanceId: "codex-default",
            cursor: "opaque:cursor",
          },
        ],
      },
    });
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      JSON.stringify({ catalogEntries: [], scans: [] }, null, 2),
    ]);
  });

  it("changes a model only through the fenced Session Fabric endpoint", async () => {
    const changeModel = vi.fn(async () => ({ command: { id: "command-1" } }));
    stubServerApi({
      "v1.session-fabric.bindings.:bindingId.model.$post": changeModel,
    });

    await runCommand(
      [
        "session",
        "change-model",
        "binding-1",
        "--provider",
        "codex",
        "--model",
        "gpt-5",
        "--reasoning-level",
        "high",
        "--service-tier",
        "default",
        "--json",
      ],
      register,
    );
    expect(changeModel).toHaveBeenCalledWith({
      param: { bindingId: "binding-1" },
      json: {
        reasoningLevel: "high",
        requestedModel: { modelId: "gpt-5", providerId: "codex" },
        serviceTier: "default",
      },
    });
  });

  it("activates and audits handoffs through explicit transition commands", async () => {
    const activate = vi.fn(async () => ({
      transition: { id: "transition-1" },
    }));
    const audit = vi.fn(async () => ({ transition: { id: "transition-1" } }));
    stubServerApi({
      "v1.session-fabric.handoffs.:transitionId.activate.$post": activate,
      "v1.session-fabric.handoffs.:transitionId.$get": audit,
    });
    const capsuleHash = `sha256:${"a".repeat(64)}`;

    await runCommand(
      [
        "session",
        "handoff",
        "activate",
        "transition-1",
        "--capsule-hash",
        capsuleHash,
        "--reviewer",
        "reviewer-1",
        "--json",
      ],
      register,
    );
    await runCommand(
      ["session", "handoff", "show", "transition-1", "--json"],
      register,
    );

    expect(activate).toHaveBeenCalledWith({
      param: { transitionId: "transition-1" },
      json: {
        capsuleContentHash: capsuleHash,
        reviewerId: "reviewer-1",
      },
    });
    expect(audit).toHaveBeenCalledWith({
      param: { transitionId: "transition-1" },
    });
  });

  it("documents schema-validated file input for handoff preparation", async () => {
    const help = await getHelpOutput(
      ["session", "handoff", "prepare"],
      register,
    );
    expect(help).toContain("--request-file <path>");
    expect(help).toContain("SessionFabricHandoffPrepareRequest");
  });
});
