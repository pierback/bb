import { readFile } from "node:fs/promises";
import { Command } from "commander";
import {
  sessionFabricAdoptionRequestSchema,
  sessionFabricDiscoveryProviderCursorSchema,
  sessionFabricDiscoveryRequestSchema,
  sessionFabricHandoffActivateRequestSchema,
  sessionFabricHandoffPrepareRequestSchema,
  sessionFabricModelChangeRequestSchema,
  type SessionFabricDiscoveryProviderCursor,
  type SessionFabricHandoffPrepareRequest,
} from "@bb/server-contract";
import { action } from "../action.js";
import { createCliBbSdk } from "../client.js";
import {
  confirmDestructiveAction,
  outputJson,
  prependErrorContext,
} from "./helpers.js";
import { resolveMachineHostId, resolveMachineTargetOption } from "./machine.js";

interface JsonOptions {
  json?: boolean;
}

interface SessionDiscoveryOptions extends JsonOptions {
  cursor: string[];
  host?: string;
  includeUnmapped?: boolean;
  limit: string;
  machine?: string;
  project: string[];
}

interface SessionAdoptionOptions extends JsonOptions {
  idempotencyKey: string;
  objective: string;
  thread: string;
  title: string;
}

interface SessionModelChangeOptions extends JsonOptions {
  model: string;
  provider: string;
  reasoningLevel: string;
  serviceTier: string;
}

interface SessionHandoffPrepareOptions extends JsonOptions {
  requestFile: string;
}

interface SessionHandoffActivateOptions extends JsonOptions {
  capsuleHash: string;
  reviewer: string;
}

interface SessionHandoffAbortOptions extends JsonOptions {
  yes?: boolean;
}

function collectValue(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parsePositiveInteger(value: string, option: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${option} must be a positive integer.`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${option} must be a positive safe integer.`);
  }
  return parsed;
}

function parseDiscoveryCursor(
  value: string,
): SessionFabricDiscoveryProviderCursor {
  const firstSeparator = value.indexOf(":");
  const secondSeparator = value.indexOf(":", firstSeparator + 1);
  if (firstSeparator <= 0 || secondSeparator <= firstSeparator + 1) {
    throw new Error(
      "--cursor must use <provider-id>:<provider-instance-id>:<cursor>.",
    );
  }
  return sessionFabricDiscoveryProviderCursorSchema.parse({
    providerId: value.slice(0, firstSeparator),
    providerInstanceId: value.slice(firstSeparator + 1, secondSeparator),
    cursor: value.slice(secondSeparator + 1),
  });
}

async function readHandoffPrepareRequest(
  filePath: string,
): Promise<SessionFabricHandoffPrepareRequest> {
  try {
    const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
    return sessionFabricHandoffPrepareRequestSchema.parse(value);
  } catch (error) {
    throw prependErrorContext(
      `Invalid Session Fabric handoff request file '${filePath}'`,
      error,
    );
  }
}

function printResult(options: JsonOptions, result: unknown): void {
  if (outputJson(options, result)) return;
  console.log(JSON.stringify(result, null, 2));
}

export function registerSessionCommands(
  program: Command,
  getUrl: () => string,
): void {
  const session = program
    .command("session")
    .description("Discover and safely control provider-native sessions");

  session
    .command("discover")
    .description("Scan one machine for provider-native conversations")
    .option("--machine <id-or-name>", "Machine to scan")
    .option("--host <id-or-name>", "Alias for --machine")
    .option(
      "--project <id>",
      "Project ID to map (repeatable)",
      collectValue,
      [],
    )
    .option(
      "--include-unmapped",
      "Include conversations not mapped to a project",
    )
    .option("--limit <n>", "Maximum conversations per provider", "100")
    .option(
      "--cursor <provider:instance:cursor>",
      "Provider cursor from an earlier scan (repeatable)",
      collectValue,
      [],
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (options: SessionDiscoveryOptions) => {
        const serverUrl = getUrl();
        const target = resolveMachineTargetOption(options);
        if (target === undefined) {
          throw new Error("Missing required option --machine <id-or-name>.");
        }
        const request = sessionFabricDiscoveryRequestSchema.parse({
          hostId: await resolveMachineHostId({
            requireConnected: true,
            serverUrl,
            target,
          }),
          includeUnmapped: options.includeUnmapped ?? false,
          limitPerProvider: parsePositiveInteger(options.limit, "--limit"),
          projectIds: options.project,
          providerCursors: options.cursor.map(parseDiscoveryCursor),
        });
        printResult(
          options,
          await createCliBbSdk(serverUrl).sessionFabric.discover(request),
        );
      }),
    );

  session
    .command("adopt <catalog-conversation-id>")
    .description("Adopt a discovered conversation into an existing thread")
    .requiredOption("--thread <id>", "Destination bb thread ID")
    .requiredOption("--title <title>", "Workstream title")
    .requiredOption("--objective <objective>", "Workstream objective")
    .requiredOption(
      "--idempotency-key <key>",
      "Stable retry key (16-200 characters)",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          catalogConversationId: string,
          options: SessionAdoptionOptions,
        ) => {
          const request = sessionFabricAdoptionRequestSchema.parse({
            idempotencyKey: options.idempotencyKey,
            objective: options.objective,
            threadId: options.thread,
            title: options.title,
          });
          printResult(
            options,
            await createCliBbSdk(getUrl()).sessionFabric.adopt({
              catalogConversationId,
              ...request,
            }),
          );
        },
      ),
    );

  session
    .command("change-model <binding-id>")
    .description("Change a bound session model through the fenced command path")
    .requiredOption("--provider <id>", "Provider ID")
    .requiredOption("--model <id>", "Provider model ID")
    .requiredOption("--reasoning-level <level>", "Reasoning level")
    .requiredOption("--service-tier <tier>", "Service tier: fast or default")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (bindingId: string, options: SessionModelChangeOptions) => {
        const request = sessionFabricModelChangeRequestSchema.parse({
          reasoningLevel: options.reasoningLevel,
          requestedModel: {
            modelId: options.model,
            providerId: options.provider,
          },
          serviceTier: options.serviceTier,
        });
        printResult(
          options,
          await createCliBbSdk(getUrl()).sessionFabric.changeModel({
            bindingId,
            ...request,
          }),
        );
      }),
    );

  session
    .command("command <command-id>")
    .description("Show the command, lifecycle events, model epoch, and receipt")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (commandId: string, options: JsonOptions) => {
        printResult(
          options,
          await createCliBbSdk(getUrl()).sessionFabric.commandAudit({
            commandId,
          }),
        );
      }),
    );

  const handoff = session
    .command("handoff")
    .description("Prepare, activate, abort, and audit safe provider handoffs");

  handoff
    .command("prepare <source-binding-id>")
    .description("Prepare a handoff from a schema-validated JSON request file")
    .requiredOption(
      "--request-file <path>",
      "JSON SessionFabricHandoffPrepareRequest on this CLI machine",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          sourceBindingId: string,
          options: SessionHandoffPrepareOptions,
        ) => {
          printResult(
            options,
            await createCliBbSdk(getUrl()).sessionFabric.prepareHandoff({
              sourceBindingId,
              ...(await readHandoffPrepareRequest(options.requestFile)),
            }),
          );
        },
      ),
    );

  handoff
    .command("activate <transition-id>")
    .description("Review, restate, verify, and activate a prepared handoff")
    .requiredOption(
      "--capsule-hash <sha256>",
      "Reviewed capsule hash (sha256:<64 lowercase hex>)",
    )
    .requiredOption("--reviewer <id>", "Reviewer identity")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          transitionId: string,
          options: SessionHandoffActivateOptions,
        ) => {
          const request = sessionFabricHandoffActivateRequestSchema.parse({
            capsuleContentHash: options.capsuleHash,
            reviewerId: options.reviewer,
          });
          printResult(
            options,
            await createCliBbSdk(getUrl()).sessionFabric.activateHandoff({
              transitionId,
              ...request,
            }),
          );
        },
      ),
    );

  handoff
    .command("abort <transition-id>")
    .description("Abort a pre-swap handoff and restore source authority")
    .option("--yes", "Skip the confirmation prompt")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (transitionId: string, options: SessionHandoffAbortOptions) => {
          if (
            !options.yes &&
            !(await confirmDestructiveAction(
              `Abort Session Fabric handoff ${transitionId}?`,
            ))
          ) {
            console.log("Aborted.");
            return;
          }
          printResult(
            options,
            await createCliBbSdk(getUrl()).sessionFabric.abortHandoff({
              transitionId,
            }),
          );
        },
      ),
    );

  handoff
    .command("show <transition-id>")
    .description("Show the complete handoff audit record")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (transitionId: string, options: JsonOptions) => {
        printResult(
          options,
          await createCliBbSdk(getUrl()).sessionFabric.handoffAudit({
            transitionId,
          }),
        );
      }),
    );
}
