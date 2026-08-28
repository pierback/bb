import { useCallback, useMemo, useState } from "react";
import type { TypeaheadConfig } from "@/components/promptbox/PromptBoxInternal";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import type { PromptBoxAction } from "@/components/promptbox/PromptBoxActionsMenu";
import { withAppPromptActions } from "@/components/promptbox/PromptBoxActionsMenu";
import type { ProviderComposerAction } from "@bb/domain";
import {
  buildProviderPromptActionProps,
  type ProviderCommandSuggestion,
} from "@bb/client-core";
import { useCommandSuggestions } from "@/hooks/useCommandSuggestions";
import { usePromptMentions } from "@/hooks/usePromptMentions";

interface UseComposerTypeaheadArgs {
  projectId: string;
  /** Project scope for @-mentions when it differs from the command scope. */
  mentionsProjectId?: string;
  providerId: string;
  environmentId: string | null;
  /** The thread the composer belongs to (excluded from thread mentions). */
  currentThreadId: string;
  /** App-local commands available only on this composer surface. */
  localCommands?: readonly ProviderCommandSuggestion[];
  selectedProviderComposerActions:
    | readonly ProviderComposerAction[]
    | undefined;
  resolveMentionLink: PromptMentionLinkResolver;
}

interface UseComposerTypeaheadResult {
  typeaheadConfig: TypeaheadConfig;
  typeaheadConfigWithoutLocalCommands: TypeaheadConfig;
  promptActions: readonly PromptBoxAction[];
}

/**
 * The @-mention and command-trigger typeahead wiring shared by every
 * thread-chat composer, plus the provider prompt actions (with the app-owned
 * actions appended) that seed the command suggestion list.
 */
export function useComposerTypeahead({
  projectId,
  mentionsProjectId,
  providerId,
  environmentId,
  currentThreadId,
  localCommands,
  selectedProviderComposerActions,
  resolveMentionLink,
}: UseComposerTypeaheadArgs): UseComposerTypeaheadResult {
  const promptMentions = usePromptMentions(mentionsProjectId ?? projectId, {
    currentThreadId,
    environmentId,
    threadStorageThreadId: currentThreadId,
  });
  const [commandQuery, setCommandQuery] = useState<string | null>(null);
  const [hasComposerFocused, setHasComposerFocused] = useState(false);
  const handleEditorFocus = useCallback(() => {
    setHasComposerFocused(true);
  }, []);
  const providerPromptActions = useMemo(
    () => buildProviderPromptActionProps(selectedProviderComposerActions ?? []),
    [selectedProviderComposerActions],
  );
  const promptActions = useMemo(
    () => withAppPromptActions(providerPromptActions.promptActions),
    [providerPromptActions.promptActions],
  );
  const commandSuggestions = useCommandSuggestions({
    projectId,
    providerId,
    commandScope: "thread",
    skillsTrigger: providerPromptActions.skillsTrigger,
    localCommands,
    promptActions,
    environmentId,
    query: commandQuery,
    composerFocused: hasComposerFocused,
  });

  const typeaheadConfig = useMemo<TypeaheadConfig>(
    () => ({
      mention: {
        triggers: promptMentions.triggers,
        suggestions: promptMentions.suggestions,
        isLoading: promptMentions.isLoading,
        isError: promptMentions.isError,
        onQueryChange: promptMentions.setQuery,
        resolveLink: resolveMentionLink,
      },
      command: {
        trigger: commandSuggestions.trigger,
        suggestions: commandSuggestions.suggestions,
        isLoading: commandSuggestions.isLoading,
        isError: commandSuggestions.isError,
        hasMore: commandSuggestions.hasMore,
        isLoadingMore: commandSuggestions.isLoadingMore,
        loadMore: commandSuggestions.loadMore,
        onQueryChange: setCommandQuery,
        onEditorFocus: handleEditorFocus,
      },
    }),
    [
      commandSuggestions.hasMore,
      commandSuggestions.isError,
      commandSuggestions.isLoading,
      commandSuggestions.isLoadingMore,
      commandSuggestions.loadMore,
      commandSuggestions.suggestions,
      commandSuggestions.trigger,
      handleEditorFocus,
      promptMentions.isError,
      promptMentions.isLoading,
      promptMentions.setQuery,
      promptMentions.suggestions,
      promptMentions.triggers,
      resolveMentionLink,
    ],
  );

  const typeaheadConfigWithoutLocalCommands = useMemo<TypeaheadConfig>(
    () => ({
      mention: typeaheadConfig.mention,
      command: {
        ...commandSuggestions.withoutLocalCommands,
        onQueryChange: setCommandQuery,
      },
    }),
    [commandSuggestions.withoutLocalCommands, typeaheadConfig.mention],
  );

  return {
    typeaheadConfig,
    typeaheadConfigWithoutLocalCommands,
    promptActions,
  };
}
