import { describe, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { allThreadConversationRoutesQueryKeyPrefix } from "../queries/query-keys";
import {
  invalidateThreadDeleteQueries,
  refetchThreadListsAfterComposerThreadCreate,
} from "./mutation-cache-effects";

describe("conversation route mutation cache effects", () => {
  it("refetches mounted route families immediately after thread creation", () => {
    const { queryClient } = createQueryClientTestHarness();
    const refetchQueries = vi.spyOn(queryClient, "refetchQueries");

    refetchThreadListsAfterComposerThreadCreate({ queryClient });

    expect(refetchQueries).toHaveBeenCalledWith({
      queryKey: allThreadConversationRoutesQueryKeyPrefix(),
      type: "active",
    });
  });

  it("invalidates route families after permanent deletion", () => {
    const { queryClient } = createQueryClientTestHarness();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    invalidateThreadDeleteQueries({ queryClient });

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: allThreadConversationRoutesQueryKeyPrefix(),
    });
  });
});
