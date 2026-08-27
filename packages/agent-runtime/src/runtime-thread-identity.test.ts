import type { ThreadEvent } from "@bb/domain";
import { turnScope } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  RuntimeThreadIdentityRegistry,
  stampThreadEventScope,
} from "./runtime-thread-identity.js";

describe("RuntimeThreadIdentityRegistry", () => {
  it("records provider ownership and resolves provider thread identities", () => {
    const registry = new RuntimeThreadIdentityRegistry();
    const providerState = registry.createProviderState({ providerId: "codex" });

    registry.registerThreadProvider({
      providerId: "codex",
      providerState,
      expectsIdentityNotification: true,
      threadId: "thread-1",
    });
    registry.recordProviderThreadIdentity({
      providerState,
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
    });

    expect(registry.resolveProviderForThread("thread-1")).toBe("codex");
    expect(registry.getProviderThreadId("thread-1")).toBe("provider-thread-1");
    expect(
      registry.resolveBbThreadIdForProviderThread({
        providerState,
        providerThreadId: "provider-thread-1",
      }),
    ).toBe("thread-1");
  });

  it("resolves explicit bb and provider thread identities", () => {
    const registry = new RuntimeThreadIdentityRegistry();
    const providerState = registry.createProviderState({ providerId: "codex" });
    registry.registerThreadProvider({
      providerId: "codex",
      providerState,
      expectsIdentityNotification: false,
      threadId: "thread-1",
    });
    registry.registerThreadProvider({
      providerId: "codex",
      providerState,
      expectsIdentityNotification: false,
      threadId: "thread-2",
    });
    registry.recordProviderThreadIdentity({
      providerState,
      threadId: "thread-2",
      providerThreadId: "provider-thread-2",
    });

    expect(
      registry.resolveProviderEventThreadId({
        providerState,
        sourceThreadId: "thread-1",
        eventThreadId: "provider-thread-2",
      }),
    ).toBe("thread-1");
    expect(
      registry.resolveProviderEventThreadId({
        providerState,
        sourceThreadId: undefined,
        eventThreadId: "thread-2",
      }),
    ).toBe("thread-2");
    expect(
      registry.resolveProviderEventThreadId({
        providerState,
        sourceThreadId: "provider-thread-2",
        eventThreadId: undefined,
      }),
    ).toBe("thread-2");
    expect(
      registry.resolveProviderEventThreadId({
        providerState,
        sourceThreadId: undefined,
        eventThreadId: "unknown-provider-thread",
      }),
    ).toBeUndefined();
  });

  it("fails closed for unknown explicit identities and only falls back for id-less events", () => {
    const registry = new RuntimeThreadIdentityRegistry();
    const singleThreadState = registry.createProviderState({
      providerId: "claude-code",
    });
    registry.registerThreadProvider({
      providerId: "claude-code",
      providerState: singleThreadState,
      expectsIdentityNotification: false,
      threadId: "thread-3",
    });
    expect(
      registry.resolveProviderEventThreadId({
        providerState: singleThreadState,
        sourceThreadId: undefined,
        eventThreadId: "unknown-provider-thread",
      }),
    ).toBeUndefined();

    expect(
      registry.resolveProviderEventThreadId({
        providerState: singleThreadState,
        sourceThreadId: "unknown-provider-source",
        eventThreadId: undefined,
      }),
    ).toBeUndefined();

    expect(
      registry.resolveProviderEventThreadId({
        providerState: singleThreadState,
        sourceThreadId: undefined,
        eventThreadId: undefined,
      }),
    ).toBe("thread-3");

    const foreignProviderState = registry.createProviderState({
      providerId: "codex",
    });
    registry.registerThreadProvider({
      providerId: "codex",
      providerState: foreignProviderState,
      expectsIdentityNotification: false,
      threadId: "thread-1",
    });
    expect(
      registry.resolveProviderEventThreadId({
        providerState: singleThreadState,
        sourceThreadId: undefined,
        eventThreadId: "thread-1",
      }),
    ).toBeUndefined();
  });

  it("stamps projected events with the resolved bb thread id", () => {
    const event: ThreadEvent = {
      type: "turn/started",
      threadId: "provider-thread-1",
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
    };

    expect(
      stampThreadEventScope({
        event,
        threadId: "thread-1",
        providerThreadId: "provider-thread-1",
      }),
    ).toEqual({
      type: "turn/started",
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
    });
  });
});
