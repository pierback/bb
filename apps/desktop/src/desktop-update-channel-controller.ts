import type { BbDesktopUpdateChannel } from "@bb/desktop-contract";
import type { DesktopAutoUpdateService } from "./desktop-auto-update.js";
import type { DesktopUpdateService } from "./desktop-update-check.js";
import type { DesktopUpdateChannelStore } from "./desktop-update-channel-store.js";
import {
  createDesktopAutoUpdateFeedConfig,
  createDesktopVersionFeedUrl,
} from "./desktop-update-provider.js";

export interface DesktopUpdateChannelController {
  getChannel(): BbDesktopUpdateChannel;
  reconcilePersistedChannel(channel: BbDesktopUpdateChannel): Promise<void>;
  setChannel(channel: BbDesktopUpdateChannel): Promise<void>;
}

export interface CreateDesktopUpdateChannelControllerArgs {
  autoUpdateService: DesktopAutoUpdateService;
  channelStore: DesktopUpdateChannelStore;
  updateService: DesktopUpdateService;
}

/**
 * Owns the one safety-critical transition shared by the JSON version feed,
 * electron-updater, and durable local preference. The store is committed only
 * after both live clients accept the new Pierback target; a failed commit rolls
 * the clients back to the previous channel.
 */
export function createDesktopUpdateChannelController(
  args: CreateDesktopUpdateChannelControllerArgs,
): DesktopUpdateChannelController {
  let transitionTail: Promise<void> = Promise.resolve();

  function applyLiveTarget(channel: BbDesktopUpdateChannel): void {
    args.autoUpdateService.setUpdateTarget(
      createDesktopAutoUpdateFeedConfig(channel),
    );
    args.updateService.setUpdateTarget({
      channel,
      feedUrl: createDesktopVersionFeedUrl(channel),
    });
  }

  async function applyChannelTransition(
    channel: BbDesktopUpdateChannel,
    commit: () => Promise<void> | void,
  ): Promise<void> {
    const previousChannel = args.channelStore.getChannel();
    if (channel === previousChannel) {
      return;
    }

    args.autoUpdateService.assertUpdateTargetCanChange();
    try {
      applyLiveTarget(channel);
      await commit();
    } catch (error) {
      try {
        applyLiveTarget(previousChannel);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "The update channel change failed and its live target could not be rolled back.",
        );
      }
      throw error;
    }
  }

  return {
    getChannel() {
      return args.channelStore.getChannel();
    },
    reconcilePersistedChannel(channel) {
      const transition = transitionTail.then(() =>
        applyChannelTransition(channel, () => {
          args.channelStore.adoptChannel(channel);
        }),
      );
      transitionTail = transition.catch(() => undefined);
      return transition;
    },
    setChannel(channel) {
      const transition = transitionTail.then(() =>
        applyChannelTransition(channel, () =>
          args.channelStore.setChannel(channel),
        ),
      );
      transitionTail = transition.catch(() => undefined);
      return transition;
    },
  };
}
