import { useMutation, useQueryClient } from "@tanstack/react-query";
import { appToast } from "@/components/ui/app-toast";
import { invalidateEnvironmentSessionConnections } from "@/hooks/cache-owners/environment-cache-effects";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { sdk } from "@/lib/sdk";

interface ConnectThreadSessionRequest {
  environmentId: string;
  threadId: string;
}

export function useConnectThreadSession() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Could not connect conversation.",
      showErrorToast: false,
    },
    mutationFn: ({ threadId }: ConnectThreadSessionRequest) =>
      sdk.sessionFabric.connectThread({ threadId }),
    onSuccess: ({ connection }, variables) => {
      invalidateEnvironmentSessionConnections({
        environmentId: connection.environmentId ?? variables.environmentId,
        queryClient,
      });
      appToast.success("Conversation connected", {
        description:
          connection.nativeConversation.title ??
          connection.nativeConversation.nativeConversationId,
      });
    },
    onError: (error) => {
      appToast.error("Could not connect conversation", {
        description: getMutationErrorMessage({
          error,
          fallbackMessage: "Session Fabric could not bind this conversation.",
        }),
      });
    },
  });
}
