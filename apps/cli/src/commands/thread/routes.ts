import { Command } from "commander";
import type {
  ConversationRoute,
  ConversationRouteStep,
} from "@bb/server-contract";
import { action } from "../../action.js";
import { createCliBbSdk } from "../../client.js";
import { outputJson, requireThreadIdOrSelf } from "../helpers.js";

interface ThreadRoutesCommandOptions {
  json?: boolean;
  self?: boolean;
}

function displayTitle(
  value: Pick<ConversationRouteStep, "threadId" | "title" | "titleFallback">,
): string {
  const explicitTitle = value.title?.trim();
  if (explicitTitle) return explicitTitle;
  const fallbackTitle = value.titleFallback?.trim();
  if (fallbackTitle) return fallbackTitle;
  return `Thread ${value.threadId.slice(0, 8)}`;
}

function formatRouteLine(route: ConversationRoute, current: boolean): string {
  const depth = route.path.length - 1;
  const branch = depth === 0 ? "" : `${"  ".repeat(depth - 1)}└─ `;
  const marker = current ? "●" : "○";
  const archived = route.archivedAt === null ? "" : " · archived";
  return `${marker} ${branch}${displayTitle(route)} · ${route.status}${archived} · ${route.threadId}`;
}

export function registerRoutesCommand(
  parent: Command,
  getUrl: () => string,
): void {
  parent
    .command("routes [id]")
    .description("List alternate conversation routes for a thread")
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (id: string | undefined, opts: ThreadRoutesCommandOptions) => {
          const threadId = requireThreadIdOrSelf(id, opts);
          const result = await createCliBbSdk(
            getUrl(),
          ).threads.experimental_conversationRoutes({ threadId });

          if (outputJson(opts, result)) return;

          const currentIndex = result.routes.findIndex(
            (route) => route.threadId === result.currentThreadId,
          );
          console.log(
            `Conversation routes (${currentIndex + 1} of ${result.routes.length} selected):`,
          );
          for (const route of result.routes) {
            console.log(
              formatRouteLine(route, route.threadId === result.currentThreadId),
            );
          }
          console.log("Open one with: bb thread open <thread-id>");
        },
      ),
    );
}
