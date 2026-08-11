import {
  defineRpcContract,
  type BbPluginApi,
  type PluginCliContext,
  type PluginCliResult,
} from "@bb/plugin-sdk";
import { z } from "zod";

export const SESSION_FABRIC_PLUGIN_VERSION = "0.1.0";

export const sessionFabricConnectionViewSchema = z
  .object({
    adoptionStatus: z.string().min(1).nullable(),
    bindingId: z.string().min(1),
    controlEpoch: z.number().int().nonnegative(),
    effectiveModel: z
      .object({
        modelId: z.string().min(1),
        providerId: z.string().min(1),
      })
      .strict()
      .nullable(),
    environmentId: z.string().min(1).nullable(),
    isActiveAuthority: z.boolean(),
    mutationPolicy: z.string().min(1),
    nativeConversation: z
      .object({
        catalogConversationId: z.string().min(1),
        cwd: z.string().min(1).nullable(),
        hostId: z.string().min(1),
        lastObservedAt: z.number().int().nonnegative(),
        nativeConversationId: z.string().min(1),
        providerId: z.string().min(1),
        providerInstanceId: z.string().min(1),
        providerState: z.string().min(1),
        title: z.string().min(1).nullable(),
      })
      .strict(),
    openedAt: z.number().int().nonnegative(),
    ownership: z.string().min(1),
    phase: z.string().min(1),
    reasoningLevel: z.string().min(1).nullable(),
    runtime: z
      .object({
        id: z.string().min(1),
        status: z.string().min(1),
      })
      .strict()
      .nullable(),
    serviceTier: z.string().min(1).nullable(),
    threadId: z.string().min(1),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export type SessionFabricConnectionView = z.infer<
  typeof sessionFabricConnectionViewSchema
>;

const threadInputSchema = z
  .object({ threadId: z.string().trim().min(1) })
  .strict();

const connectionResponseSchema = z
  .object({ connection: sessionFabricConnectionViewSchema.nullable() })
  .strict();

export const sessionFabricRpcContract = defineRpcContract({
  threadConnection: {
    input: threadInputSchema,
    output: connectionResponseSchema,
  },
  connectThread: {
    input: threadInputSchema,
    output: z
      .object({ connection: sessionFabricConnectionViewSchema })
      .strict(),
  },
});

type ThreadConnectionResult = Awaited<
  ReturnType<BbPluginApi["sdk"]["sessionFabric"]["threadConnection"]>
>;
type CoreConnection = NonNullable<ThreadConnectionResult["connection"]>;

/**
 * Keep the plugin wire contract narrow and display-oriented. The SDK remains
 * the authority; this projection prevents the app bundle from depending on
 * server/domain implementation packages.
 */
export function projectConnection(
  connection: CoreConnection,
): SessionFabricConnectionView {
  return {
    adoptionStatus: connection.adoptionStatus,
    bindingId: connection.bindingId,
    controlEpoch: connection.controlEpoch,
    effectiveModel: connection.effectiveModel,
    environmentId: connection.environmentId,
    isActiveAuthority: connection.isActiveAuthority,
    mutationPolicy: connection.mutationPolicy,
    nativeConversation: {
      catalogConversationId:
        connection.nativeConversation.catalogConversationId,
      cwd: connection.nativeConversation.cwd,
      hostId: connection.nativeConversation.hostId,
      lastObservedAt: connection.nativeConversation.lastObservedAt,
      nativeConversationId: connection.nativeConversation.nativeConversationId,
      providerId: connection.nativeConversation.providerId,
      providerInstanceId: connection.nativeConversation.providerInstanceId,
      providerState: connection.nativeConversation.providerState,
      title: connection.nativeConversation.title,
    },
    openedAt: connection.openedAt,
    ownership: connection.ownership,
    phase: connection.phase,
    reasoningLevel: connection.reasoningLevel,
    runtime: connection.runtime,
    serviceTier: connection.serviceTier,
    threadId: connection.threadId,
    updatedAt: connection.updatedAt,
  };
}

class CliUsageError extends Error {}

const CLI_USAGE = `Usage:
  bb fabric status [thread-id] [--json]
  bb fabric connect [thread-id] [--json]
  bb fabric command <command-id> [--json]
  bb fabric handoff <transition-id> [--json]`;

interface ParsedCliArgs {
  command: string;
  json: boolean;
  positionals: string[];
}

function parseCliArgs(argv: string[]): ParsedCliArgs {
  const [command, ...rest] = argv;
  if (!command) throw new CliUsageError(CLI_USAGE);
  let json = false;
  const positionals: string[] = [];
  for (const value of rest) {
    if (value === "--json") {
      if (json) throw new CliUsageError("--json may only be supplied once");
      json = true;
    } else if (value.startsWith("--")) {
      throw new CliUsageError(`Unknown option: ${value}`);
    } else {
      positionals.push(value);
    }
  }
  return { command, json, positionals };
}

function requireThreadId(
  positionals: string[],
  context: PluginCliContext,
): string {
  if (positionals.length > 1) {
    throw new CliUsageError("Expected at most one thread id");
  }
  const threadId = positionals[0] ?? context.threadId;
  if (!threadId) {
    throw new CliUsageError(
      "A thread id is required outside a BB thread context",
    );
  }
  return threadId;
}

function requireIdentifier(positionals: string[], label: string): string {
  if (positionals.length !== 1 || !positionals[0]) {
    throw new CliUsageError(`Exactly one ${label} is required`);
  }
  return positionals[0];
}

function withSignal<T extends object>(
  args: T,
  signal: AbortSignal | undefined,
): T & { signal?: AbortSignal } {
  return signal === undefined ? args : { ...args, signal };
}

function asJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function displayToken(value: string): string {
  return value.replaceAll("_", " ");
}

export function formatConnection(
  connection: SessionFabricConnectionView | null,
  threadId: string,
): string {
  if (connection === null) {
    return `Thread ${threadId} is not connected to Session Fabric.\n`;
  }
  const conversation =
    connection.nativeConversation.title ??
    connection.nativeConversation.nativeConversationId;
  const model = connection.effectiveModel
    ? `${connection.effectiveModel.providerId}/${connection.effectiveModel.modelId}`
    : "not reported";
  const runtime = connection.runtime
    ? `${displayToken(connection.runtime.status)} (${connection.runtime.id})`
    : "not attached";
  return [
    `Thread: ${connection.threadId}`,
    `Conversation: ${conversation}`,
    `Provider: ${connection.nativeConversation.providerId} (${connection.nativeConversation.providerInstanceId})`,
    `Host: ${connection.nativeConversation.hostId}`,
    `State: ${displayToken(connection.phase)} · ${connection.isActiveAuthority ? "active authority" : "not authority"} · ${displayToken(connection.mutationPolicy)}`,
    `Runtime: ${runtime}`,
    `Model: ${model}`,
    `Binding: ${connection.bindingId} (epoch ${connection.controlEpoch})`,
    "",
  ].join("\n");
}

function formatCommandAudit(
  audit: Awaited<
    ReturnType<BbPluginApi["sdk"]["sessionFabric"]["commandAudit"]>
  >,
): string {
  return [
    `Command: ${audit.command.id}`,
    `Kind: ${displayToken(audit.command.kind)}`,
    `Status: ${displayToken(audit.command.status)}`,
    `Binding: ${audit.command.bindingId}`,
    `Events: ${audit.events.length}`,
    `Receipt: ${audit.receipt === null ? "none" : "recorded"}`,
    "",
  ].join("\n");
}

function formatHandoffAudit(
  audit: Awaited<
    ReturnType<BbPluginApi["sdk"]["sessionFabric"]["handoffAudit"]>
  >,
): string {
  const evidence = [
    audit.authorization !== null ? "authorization" : null,
    audit.capsule !== null ? "capsule" : null,
    audit.review !== null ? "review" : null,
    audit.restatement !== null ? "restatement" : null,
    audit.settlement !== null ? "settlement" : null,
  ].filter((value): value is string => value !== null);
  return [
    `Handoff: ${audit.transition.id}`,
    `Phase: ${displayToken(audit.transition.phase)}`,
    `Source binding: ${audit.transition.sourceBindingId}`,
    `Destination thread: ${audit.transition.destinationThreadId}`,
    `Events: ${audit.events.length}`,
    `Evidence: ${evidence.length === 0 ? "none" : evidence.join(", ")}`,
    "",
  ].join("\n");
}

export function registerSessionFabricCli(
  bb: Pick<BbPluginApi, "cli" | "sdk">,
): void {
  bb.cli.register({
    name: "fabric",
    summary: "Inspect and operate portable provider sessions",
    commands: [
      {
        name: "status",
        summary: "Show a thread's Session Fabric connection",
        usage: "bb fabric status [thread-id] [--json]",
      },
      {
        name: "connect",
        summary: "Connect a BB thread to its provider session",
        usage: "bb fabric connect [thread-id] [--json]",
      },
      {
        name: "command",
        summary: "Show the durable audit for one mutation command",
        usage: "bb fabric command <command-id> [--json]",
      },
      {
        name: "handoff",
        summary: "Show the durable audit for one handoff",
        usage: "bb fabric handoff <transition-id> [--json]",
      },
    ],
    async run(argv, context): Promise<PluginCliResult> {
      if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help") {
        return { exitCode: 0, stdout: `${CLI_USAGE}\n` };
      }
      try {
        const parsed = parseCliArgs(argv);
        if (parsed.command === "status") {
          const threadId = requireThreadId(parsed.positionals, context);
          const result = await bb.sdk.sessionFabric.threadConnection(
            withSignal({ threadId }, context.signal),
          );
          const view = {
            connection:
              result.connection === null
                ? null
                : projectConnection(result.connection),
          };
          return {
            exitCode: 0,
            stdout: parsed.json
              ? asJson(view)
              : formatConnection(view.connection, threadId),
          };
        }
        if (parsed.command === "connect") {
          const threadId = requireThreadId(parsed.positionals, context);
          const result = await bb.sdk.sessionFabric.connectThread(
            withSignal({ threadId }, context.signal),
          );
          const view = { connection: projectConnection(result.connection) };
          return {
            exitCode: 0,
            stdout: parsed.json
              ? asJson(view)
              : formatConnection(view.connection, threadId),
          };
        }
        if (parsed.command === "command") {
          const commandId = requireIdentifier(parsed.positionals, "command id");
          const audit = await bb.sdk.sessionFabric.commandAudit(
            withSignal({ commandId }, context.signal),
          );
          return {
            exitCode: 0,
            stdout: parsed.json ? asJson(audit) : formatCommandAudit(audit),
          };
        }
        if (parsed.command === "handoff") {
          const transitionId = requireIdentifier(
            parsed.positionals,
            "transition id",
          );
          const audit = await bb.sdk.sessionFabric.handoffAudit(
            withSignal({ transitionId }, context.signal),
          );
          return {
            exitCode: 0,
            stdout: parsed.json ? asJson(audit) : formatHandoffAudit(audit),
          };
        }
        throw new CliUsageError(`Unknown command: ${parsed.command}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          exitCode: 1,
          stderr: `${error instanceof CliUsageError ? message : `Session Fabric failed: ${message}`}\n`,
        };
      }
    },
  });
}

export default async function plugin(bb: BbPluginApi) {
  bb.settings.define({
    showTechnicalIdentifiers: {
      type: "boolean",
      label: "Show technical identifiers",
      description:
        "Show binding, runtime, provider-instance, environment, and native conversation identifiers in the thread panel.",
      default: false,
    },
  });

  bb.rpc.register(sessionFabricRpcContract, {
    async threadConnection({ threadId }) {
      const result = await bb.sdk.sessionFabric.threadConnection({ threadId });
      return {
        connection:
          result.connection === null
            ? null
            : projectConnection(result.connection),
      };
    },
    async connectThread({ threadId }) {
      const result = await bb.sdk.sessionFabric.connectThread({ threadId });
      return { connection: projectConnection(result.connection) };
    },
  });

  registerSessionFabricCli(bb);
  bb.log.info(`Session Fabric ${SESSION_FABRIC_PLUGIN_VERSION} loaded`);
}
