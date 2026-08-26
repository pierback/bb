import { describe, expect, it } from "vitest";
import { conversationRow } from "@/test/fixtures/thread-timeline-rows";
import { timelineRowRenderSignature } from "./timelineRowSignatures";

describe("timelineRowRenderSignature", () => {
  it("changes when an assistant receives its exact fork checkpoint", () => {
    const streamingAssistant = conversationRow({
      id: "assistant-answer",
      text: "Answer",
      sourceSeqStart: 20,
      sourceSeqEnd: 20,
    });
    const completedAssistant = conversationRow({
      id: "assistant-answer",
      text: "Answer",
      sourceSeqStart: 20,
      sourceSeqEnd: 20,
      forkSourceSeqEnd: 21,
    });

    expect(timelineRowRenderSignature(completedAssistant)).not.toBe(
      timelineRowRenderSignature(streamingAssistant),
    );
  });
});
