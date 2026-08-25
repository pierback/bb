import { useMemo } from "react";
import type { PromptMentionCommandTrigger } from "@bb/domain";
import {
  toProviderCommandSuggestion,
  type ProviderCommandSuggestion,
} from "@/components/promptbox/mentions/types";
import { useProjectCommands } from "./queries/project-queries";

export interface UseCommandSuggestionsArgs {
  projectId: string | undefined;
  providerId: string | undefined;
  /** Composer surface used to exclude commands that require an existing thread. */
  commandScope: "new-thread" | "thread";
  skillsTrigger: PromptMentionCommandTrigger | null;
  /** App-local commands that share the slash menu but never reach a provider. */
  localCommands?: readonly ProviderCommandSuggestion[];
  promptActions?: readonly CommandSuggestionPromptAction[];
  /**
   * Environment whose workspace scopes discovery (e.g. a thread's worktree, or
   * a reused environment in the new-thread composer), or `null` to use the
   * selected project-source host (then the primary fallback).
   */
  environmentId: string | null;
  /** Project-source host used before an environment exists. */
  hostId?: string | null;
  /** Text typed after the trigger char, or `null` when no command trigger is active. */
  query: string | null;
}

export interface CommandSuggestionState {
  /** The active command trigger char, or `null` when the feature is inert. */
  trigger: PromptMentionCommandTrigger | null;
  suggestions: ProviderCommandSuggestion[];
  /**
   * `true` only before the first result lands (and not yet placeholder-backed).
   * Distinct from a loaded-empty list, so the composer can suppress opening an
   * empty menu without flashing a spinner.
   */
  isLoading: boolean;
  isError: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
}

export interface UseCommandSuggestionsResult extends CommandSuggestionState {
  /** The same provider-backed state without commands owned by the app shell. */
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

/**
 * Filter the cached catalog without changing its order. PromptBoxInternal owns
 * the single relevance-ordering pass because it has the query under the caret.
 */
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

/**
 * Command typeahead data source, parallel to `usePromptMentions`. The selected
 * provider's `skills` composer action owns provider command discovery, while
 * app-local commands can independently activate the slash menu. Provider
 * discovery remains inert without its provider-owned trigger. Serves both the
 * existing-thread follow-up composer and the new-thread composer. Unlike
 * mentions, an active trigger is enabled even when `query` is empty so the
 * menu can show its full available list.
 */
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

  // Loading flips on only before any result is available. Once the first page
  // returns, fetching additional pages leaves suggestions populated — and a
  // loaded-empty list reports `isLoading: false` so the composer can suppress
  // opening an empty menu.
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
