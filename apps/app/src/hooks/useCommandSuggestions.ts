import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import type { PromptMentionCommandTrigger } from "@bb/domain";
import { usePointerCoarse } from "@bb/shared-ui/hooks/use-pointer-coarse";
import {
  toProviderCommandSuggestion,
  type ProviderCommandSuggestion,
} from "@bb/client-core";
import {
  projectCommandsQueryOptions,
  useProjectCommands,
} from "./queries/project-queries";

export interface UseCommandSuggestionsArgs {
  projectId: string | undefined;
  providerId: string | undefined;
  commandScope: "new-thread" | "thread";
  skillsTrigger: PromptMentionCommandTrigger | null;
  localCommands?: readonly ProviderCommandSuggestion[];
  promptActions?: readonly CommandSuggestionPromptAction[];
  environmentId: string | null;
  hostId?: string | null;
  query: string | null;
  composerFocused?: boolean;
}

const COMMAND_CATALOG_PREFETCH_STALE_TIME_MS = 30_000;

export interface CommandSuggestionState {
  trigger: PromptMentionCommandTrigger | null;
  suggestions: ProviderCommandSuggestion[];
  isLoading: boolean;
  isError: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
}

export interface UseCommandSuggestionsResult extends CommandSuggestionState {
  withoutLocalCommands: CommandSuggestionState;
}

export interface CommandSuggestionPromptAction {
  text?: string;
  command?: {
    trigger: PromptMentionCommandTrigger;
    name: string;
    trailingText: string;
  };
}

export function commandSuggestionMatchesQuery(
  suggestion: ProviderCommandSuggestion,
  query: string,
): boolean {
  if (query.length === 0) {
    return true;
  }

  return [
    suggestion.name,
    suggestion.description ?? "",
    suggestion.argumentHint ?? "",
  ]
    .join(" ")
    .toLowerCase()
    .includes(query);
}

export function filterCommandSuggestions(
  suggestions: readonly ProviderCommandSuggestion[],
  query: string,
): ProviderCommandSuggestion[] {
  const normalizedQuery = query.toLowerCase();
  return suggestions.filter((suggestion) =>
    commandSuggestionMatchesQuery(suggestion, normalizedQuery),
  );
}

export function resolveCommandSuggestionTrigger({
  skillsTrigger,
  localCommands,
}: {
  skillsTrigger: PromptMentionCommandTrigger | null;
  localCommands: readonly ProviderCommandSuggestion[] | undefined;
}): PromptMentionCommandTrigger | null {
  return skillsTrigger ?? ((localCommands?.length ?? 0) > 0 ? "/" : null);
}

export function promptActionCommandSuggestions({
  promptActions,
  query,
  trigger,
}: {
  promptActions: readonly CommandSuggestionPromptAction[] | undefined;
  query: string;
  trigger: PromptMentionCommandTrigger | null;
}): ProviderCommandSuggestion[] {
  if (trigger === null) {
    return [];
  }

  return (promptActions ?? [])
    .flatMap((action): ProviderCommandSuggestion[] => {
      if (!action.command || action.command.trigger !== trigger) {
        return [];
      }
      return [
        {
          kind: "command",
          name: action.command.name,
          source: "command",
          origin: "user",
          description: null,
          argumentHint: null,
        },
      ];
    })
    .filter((suggestion) => commandSuggestionMatchesQuery(suggestion, query));
}

function mergeCommandSuggestions(
  preferred: readonly ProviderCommandSuggestion[],
  fallback: readonly ProviderCommandSuggestion[],
): ProviderCommandSuggestion[] {
  const suggestions: ProviderCommandSuggestion[] = [];
  const seen = new Set<string>();

  for (const suggestion of [...preferred, ...fallback]) {
    const key = `${suggestion.source}:${suggestion.name}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    suggestions.push(suggestion);
  }

  return suggestions;
}

export function useCommandSuggestions(
  args: UseCommandSuggestionsArgs,
): UseCommandSuggestionsResult {
  const trigger = resolveCommandSuggestionTrigger({
    skillsTrigger: args.skillsTrigger,
    localCommands: args.localCommands,
  });
  const isActive = trigger !== null && args.query !== null;
  const isProviderCatalogActive =
    isActive &&
    args.projectId !== undefined &&
    args.providerId !== undefined &&
    args.skillsTrigger !== null;

  const trimmedQuery = args.query?.trim() ?? "";
  const localCommandSuggestions = useMemo(
    () =>
      isActive
        ? filterCommandSuggestions(args.localCommands ?? [], trimmedQuery)
        : [],
    [args.localCommands, isActive, trimmedQuery],
  );
  const promptActionSuggestions = useMemo(
    () =>
      isProviderCatalogActive
        ? promptActionCommandSuggestions({
            promptActions: args.promptActions,
            query: trimmedQuery.toLowerCase(),
            trigger: args.skillsTrigger,
          })
        : [],
    [
      args.promptActions,
      args.skillsTrigger,
      isProviderCatalogActive,
      trimmedQuery,
    ],
  );

  const commandsQuery = useProjectCommands(
    {
      projectId: args.projectId,
      providerId: args.providerId,
      environmentId: args.environmentId,
      hostId: args.hostId ?? null,
    },
    { enabled: isProviderCatalogActive },
  );
  const queryClient = useQueryClient();
  const isPointerCoarse = usePointerCoarse();
  const shouldPrefetchCatalog =
    args.composerFocused === true &&
    isPointerCoarse &&
    args.projectId !== undefined &&
    args.providerId !== undefined &&
    args.skillsTrigger !== null;
  const prefetchProjectId = args.projectId;
  const prefetchProviderId = args.providerId;
  const prefetchEnvironmentId = args.environmentId;
  const prefetchHostId = args.hostId ?? null;
  useEffect(() => {
    if (!shouldPrefetchCatalog) {
      return;
    }
    void queryClient.prefetchQuery({
      ...projectCommandsQueryOptions({
        projectId: prefetchProjectId,
        providerId: prefetchProviderId,
        environmentId: prefetchEnvironmentId,
        hostId: prefetchHostId,
      }),
      retry: false,
      staleTime: COMMAND_CATALOG_PREFETCH_STALE_TIME_MS,
    });
  }, [
    prefetchEnvironmentId,
    prefetchHostId,
    prefetchProjectId,
    prefetchProviderId,
    queryClient,
    shouldPrefetchCatalog,
  ]);

  const discoveredSuggestions = useMemo<ProviderCommandSuggestion[]>(() => {
    if (!isProviderCatalogActive) {
      return [];
    }
    return filterCommandSuggestions(
      (commandsQuery.data?.commands ?? [])
        .map(toProviderCommandSuggestion)
        .filter(
          (suggestion) =>
            args.commandScope === "thread" ||
            suggestion.source !== "command" ||
            suggestion.origin !== "builtin" ||
            suggestion.name !== "compact",
        ),
      trimmedQuery,
    );
  }, [
    args.commandScope,
    commandsQuery.data?.commands,
    isProviderCatalogActive,
    trimmedQuery,
  ]);
  const suggestionsWithoutLocalCommands = useMemo(
    () =>
      mergeCommandSuggestions(promptActionSuggestions, discoveredSuggestions),
    [discoveredSuggestions, promptActionSuggestions],
  );
  const suggestions = useMemo<ProviderCommandSuggestion[]>(() => {
    if (!isActive) {
      return [];
    }
    return mergeCommandSuggestions(
      localCommandSuggestions,
      suggestionsWithoutLocalCommands,
    );
  }, [isActive, localCommandSuggestions, suggestionsWithoutLocalCommands]);

  const isLoadingWithoutLocalCommands =
    isProviderCatalogActive &&
    suggestionsWithoutLocalCommands.length === 0 &&
    commandsQuery.data === undefined &&
    (commandsQuery.isPending || commandsQuery.isFetching);
  const isLoading = isLoadingWithoutLocalCommands && suggestions.length === 0;
  const isErrorWithoutLocalCommands =
    isProviderCatalogActive &&
    commandsQuery.isError &&
    suggestionsWithoutLocalCommands.length === 0;
  const isError = isErrorWithoutLocalCommands && suggestions.length === 0;
  const loadMore = () => {};

  return {
    trigger,
    suggestions,
    isLoading,
    isError,
    hasMore: false,
    isLoadingMore: false,
    loadMore,
    withoutLocalCommands: {
      trigger: args.skillsTrigger,
      suggestions: suggestionsWithoutLocalCommands,
      isLoading: isLoadingWithoutLocalCommands,
      isError: isErrorWithoutLocalCommands,
      hasMore: false,
      isLoadingMore: false,
      loadMore,
    },
  };
}
